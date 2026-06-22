import { z } from "zod";

export const wikiBlockOverlaySchema = z.object({
  id: z.string().min(1),
  workspaceId: z.string().min(1),
  targetBlockId: z.string().min(1).optional(),
  targetStableKey: z.string().min(1),
  overlayType: z.enum(["EDIT", "HIDE", "ADD_AFTER", "ADD_CHILD"]),
  overlayJson: z.unknown(),
  createdBy: z.string().min(1),
  reason: z.string().optional(),
  createdAt: z.coerce.date(),
  updatedAt: z.coerce.date()
});

export type WikiBlockOverlay = z.infer<typeof wikiBlockOverlaySchema>;
