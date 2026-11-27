import { Data, Effect, Predicate, Schema } from "effect";
import { Prompt } from "effect/ai";

/** Where a value stops being plain data, and what is there instead. */
export interface NotPlainData {
  /** The path to it from the value checked, such as `content[0].result.when`; empty at the top. */
  readonly path: string;
  /** What is there, such as `a Date`, `NaN` or `a cycle`. */
  readonly found: string;
}

const isJson = Schema.is(Schema.Json);

/**
 * Whether a value is plain data: JSON as Effect's `Schema.Json` defines it. That is `null`, a
 * boolean, a finite number, a string, an array of plain data, or a record (prototype
 * `Object.prototype` or `null`) whose enumerable string-keyed fields hold plain data; a field whose
 * value is `undefined` is not. The conversation holds only plain data; a Transcript adapter applies
 * this same rule to what it is given, and chooses its own format for it.
 */
export const isPlainData = (value: unknown): value is Schema.Json => isJson(value);

// oxlint-disable-next-line quality/no-unsafe-dictionary-type -- the fields of a record not yet checked, which can hold anything
type Fields = Record<string, unknown>;

/** Whether `Schema.Json` reads `value` field by field: a record whose prototype has no prototype. */
const isRecord = (value: unknown): value is Fields => {
  if (!Predicate.isObject(value)) {
    return false;
  }
  const prototype: unknown = Object.getPrototypeOf(value);
  return prototype === null || Object.getPrototypeOf(prototype) === null;
};

const at = (path: string, key: string) => (path === "" ? key : `${path}.${key}`);

/** The first place, depth first, where a value `Schema.Json` refused is not JSON, and what is there. */
const notPlainData = (
  // oxlint-disable-next-line anti-slop/no-unknown-parameters -- diagnoses a refused value: it returns where, not a narrowed type
  value: unknown,
): NotPlainData | undefined => {
  // A work list rather than recursion, so a refused value nested deeper than the stack is described
  // too. An entry without a path marks where its record or array is no longer an ancestor.
  const pending: Array<readonly [path: string | undefined, value: unknown]> = [["", value]];
  const ancestors = new Set<unknown>();
  for (let next = pending.pop(); next !== undefined; next = pending.pop()) {
    const [path, field] = next;
    if (path === undefined) {
      ancestors.delete(field);
      continue;
    }
    if (field === null || Predicate.isString(field) || Predicate.isBoolean(field)) {
      continue;
    }
    if (Predicate.isNumber(field)) {
      if (Number.isFinite(field)) {
        continue;
      }
      return { path, found: String(field) };
    }
    if (!Predicate.isObjectOrArray(field)) {
      const found = Predicate.isBigInt(field)
        ? "a bigint"
        : Predicate.isSymbol(field)
          ? "a symbol"
          : Predicate.isFunction(field)
            ? "a function"
            : "undefined";
      return { path, found };
    }
    if (ancestors.has(field)) {
      return { path, found: "a cycle" };
    }
    const fields = Array.isArray(field)
      ? Array.from(field, (item, index) => [`${path}[${index}]`, item] as const)
      : isRecord(field)
        ? Object.entries(field).map(([key, item]) => [at(path, key), item] as const)
        : undefined;
    if (fields === undefined) {
      const constructor: unknown = Object.getPrototypeOf(field)?.constructor;
      const name = Predicate.isFunction(constructor) ? constructor.name : "";
      return { path, found: name === "" ? "an object of another kind" : `a ${name}` };
    }
    ancestors.add(field);
    pending.push([undefined, field]);
    for (const entry of fields.toReversed()) {
      pending.push(entry);
    }
  }
  return undefined;
};

/**
 * A copy of an encoded Message as any store reads it back: its arrays and records copied, without
 * record fields whose value is `undefined`, and with negative zero as zero, since not every format
 * tells the two apart. Anything else is kept as it is for the check to refuse, and a cycle stays a
 * cycle.
 */
const withoutAbsent = (encoded: Prompt.MessageEncoded) => {
  const copies = new Map<object, Array<unknown> | Fields>();
  const pending: Array<() => void> = [];
  // oxlint-disable-next-line anti-slop/no-unknown-parameters -- copies a field of an encoded Message before it is checked
  const copy = (value: unknown) => {
    if (Object.is(value, -0)) {
      return 0;
    }
    if (!Array.isArray(value) && !isRecord(value)) {
      return value;
    }
    const known = copies.get(value);
    if (known !== undefined) {
      return known;
    }
    if (Array.isArray(value)) {
      const target: Array<unknown> = [];
      target.length = value.length;
      copies.set(value, target);
      // Read by index, as `Schema.Json` reads it: an array need not have the array methods.
      pending.push(() => {
        for (let index = 0; index < value.length; index += 1) {
          if (index in value) {
            target[index] = copy(value[index]);
          }
        }
      });
      return target;
    }
    const target: Fields = {};
    copies.set(value, target);
    pending.push(() => {
      for (const [key, field] of Object.entries(value)) {
        // Defined rather than assigned, so a field named `__proto__` stays a field.
        if (field !== undefined) {
          Object.defineProperty(target, key, {
            value: copy(field),
            enumerable: true,
            writable: true,
            configurable: true,
          });
        }
      }
    });
    return target;
  };
  const root = copy(encoded);
  // A work list rather than recursion, so nesting as deep as `Schema.Json` accepts is copied too.
  for (let next = pending.pop(); next !== undefined; next = pending.pop()) {
    next();
  }
  return root;
};

/** A Message whose encoded form is not plain data, and where. */
export class NotPlainMessage extends Data.TaggedError("NotPlainMessage")<NotPlainData> {}

const encodeMessage = Schema.encodeEffect(Prompt.Message);
const decodeMessage = Schema.decodeUnknownEffect(Prompt.Message);

/**
 * A Message as the conversation keeps it: decoded again from a copy of its encoded form without
 * absent fields, which is what any store reads back. Fails with where that copy stops being plain
 * data, or with the codec's error.
 */
export const conversationMessage = (message: Prompt.Message) =>
  Effect.gen(function* () {
    const kept = withoutAbsent(yield* encodeMessage(message));
    if (!isPlainData(kept)) {
      return yield* new NotPlainMessage(notPlainData(kept) ?? { path: "", found: "not JSON" });
    }
    return yield* decodeMessage(kept);
  });
