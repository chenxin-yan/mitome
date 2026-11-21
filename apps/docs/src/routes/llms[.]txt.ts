import { docsLlms } from "@/lib/source";
import { createFileRoute } from "@tanstack/react-router";

export const Route = createFileRoute("/llms.txt")({
  server: {
    handlers: {
      GET: () => new Response(docsLlms.index()),
    },
  },
});
