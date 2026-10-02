interface SelectionArea {
  x: number;
  y: number;
  width: number;
  height: number;
}

interface OCRHistoryEntry {
  id: string;
  text: string;
  confidence: number;
  timestamp: number;
  language: string;
  area?: SelectionArea;
}

interface OCRSettings {
  language: string;
  removeLineBreaks: boolean;
  mergeSpaces: boolean;
}

interface RawOcrResult {
  text?: string;
  confidence?: number;
  error?: string;
}

interface OcrRunPayload {
  imageData: string;
  area?: SelectionArea;
  language?: string;
  dpr?: number;
}

interface AuthUser {
  uid: string;
  email: string;
}

interface AuthSession extends AuthUser {
  idToken?: string;
  refreshToken: string;
  expiresAt: number;
}

interface SyncStats {
  uploaded: number;
  removed: number;
  total: number;
}

interface LocalStorage {
  history?: OCRHistoryEntry[];
  auth?: AuthSession | null;
}

interface SyncStorage extends OCRSettings {}

// ---------- runtime messages ----------
type BackgroundRequest =
  | { type: 'OCR_CAPTURE'; area: SelectionArea; dpr: number; language?: string }
  | { type: 'OCR_IMAGE_DATA'; imageData: string; language?: string }
  | { type: 'START_SELECTION_POPUP' }
  | { type: 'GET_SETTINGS' }
  | { type: 'SAVE_SETTINGS'; settings: Partial<OCRSettings> }
  | { type: 'GET_HISTORY' }
  | { type: 'CLEAR_HISTORY' }
  | { type: 'DELETE_ENTRY'; id: string }
  | { type: 'AUTH_STATE' }
  | { type: 'AUTH_SIGN_IN'; email: string; password: string }
  | { type: 'AUTH_SIGN_UP'; email: string; password: string }
  | { type: 'AUTH_SIGN_OUT' }
  | { type: 'SYNC_HISTORY' }
  | { type: 'OCR_RUN'; payload: OcrRunPayload };

type ContentRequest =
  | { type: 'START_SELECTION' }
  | { type: 'OCR_DONE'; entry: OCRHistoryEntry }
  | { type: 'OCR_FAILED'; error: string };

interface OkResponse {
  ok: boolean;
  error?: string;
}
