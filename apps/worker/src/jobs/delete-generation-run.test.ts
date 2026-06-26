import { describe, expect, it } from "vitest";

import { deletableOwnedPageIds } from "./delete-generation-run";

describe("deletableOwnedPageIds", () => {
  it("keeps owned wiki pages that are still referenced by another run", () => {
    expect(deletableOwnedPageIds(["page-1", "page-2", "page-3"], ["page-2"])).toEqual(["page-1", "page-3"]);
  });
});
