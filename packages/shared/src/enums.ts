export const repositoryRoles = ["FRONTEND", "BACKEND"] as const;
export type RepositoryRole = (typeof repositoryRoles)[number];

export const blockOrigins = ["CODE", "MANUAL", "CODE_EDITED"] as const;
export type BlockOrigin = (typeof blockOrigins)[number];

export const reviewStates = ["VERIFIED", "NEEDS_REVIEW", "OPEN_QUESTION"] as const;
export type ReviewState = (typeof reviewStates)[number];

export const overlayTypes = ["EDIT", "HIDE", "ADD_AFTER", "ADD_CHILD"] as const;
export type OverlayType = (typeof overlayTypes)[number];
