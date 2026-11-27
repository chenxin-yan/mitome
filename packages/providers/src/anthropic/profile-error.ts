import { Schema } from "effect";

/** The Claude Console profile exists but cannot be used; the message says why and how to fix it. */
export class UnusableProfileError extends Schema.TaggedError<
  UnusableProfileError,
  { readonly brand: unique symbol }
>()("UnusableProfileError", { message: Schema.String }) {}
