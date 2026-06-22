export type FrontendFactKind =
  | "ROUTE"
  | "PAGE_COMPONENT"
  | "FORM_FIELD"
  | "BUTTON_ACTION"
  | "API_CALL"
  | "NAVIGATION"
  | "VALIDATION_HINT"
  | "UI_STATE"
  | "PERMISSION_HINT";

export type BackendFactKind =
  | "API_ROUTE"
  | "CONTROLLER_HANDLER"
  | "SERVICE_METHOD"
  | "VALIDATION_RULE"
  | "DATABASE_ENTITY"
  | "PERMISSION_CHECK"
  | "ERROR_RESPONSE";

export type ScannerFactKind = FrontendFactKind | BackendFactKind;

export type ScannerFact = {
  factKey: string;
  factKind: ScannerFactKind;
  text: string;
  evidenceKeys: string[];
  confidence: number;
};
