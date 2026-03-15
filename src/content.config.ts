import { defineCollection } from "astro:content";
import { file } from "astro/loaders";
import { z } from "astro/zod";

const versionNotes = defineCollection({
  loader: file("src/data/version-notes.yaml"),
  schema: z.object({
    id: z.string(),
    note: z.string(),
  }),
});

export const collections = { versionNotes };
