import * as NodeFileSystem from "@effect/platform-node-shared/NodeFileSystem";
import * as NodePath from "@effect/platform-node-shared/NodePath";
import { Layer } from "effect";

/**
 * Effect's file system and path services, from Node's implementation, which Bun also runs.
 * `jsonlTranscripts` provides it itself, so a Configuration names no platform (ADR-0065).
 */
export const platformLayer = Layer.merge(NodeFileSystem.layer, NodePath.layer);
