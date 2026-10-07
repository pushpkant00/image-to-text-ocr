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
  showResultCard: boolean;
  openHistoryAfterOcr: boolean;
  autoDownload: boolean;
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

/** Background <-> offscreen payload/response for PDF text extraction. */
interface PdfRunPayload {
  pdfData: ArrayBuffer;
  language?: string;
}

interface PdfExtractResponse {
  text?: string;
  pages?: number;
  ocrPages?: number;
  error?: string;
}

/** Broadcast by the offscreen document after each PDF page. */
interface ConvertProgressMsg {
  page: number;
  total: number;
  ocr: boolean;
}

/** Safety net: last completed PDF extraction, restored if the popup closed. */
interface LastConvert {
  text: string;
  pages: number;
  ts: number;
  /** Convert mode active when it ran (pdf-text | pdf-word). */
  mode?: string;
  /** Original file name (with extension) for restoring the download name. */
  name?: string;
}

interface AuthUser {
  uid: string;
  email: string;
  emailVerified?: boolean;
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
  /** Raw sync-encryption keys, keyed by account uid (see background/crypto.ts). */
  syncKeys?: Record<string, string>;
  /** uid of the last account used on this device — device history is isolated per account. */
  lastAccountUid?: string | null;
  /** Last completed PDF extraction (cleared once read by the popup). */
  lastConvert?: LastConvert | null;
}

interface SyncStorage extends OCRSettings {}

// ---------- runtime messages ----------
type BackgroundRequest =
  | { type: 'OCR_CAPTURE'; area: SelectionArea; dpr: number; language?: string }
  | { type: 'OCR_IMAGE_DATA'; imageData: string; language?: string }
  | { type: 'GET_SETTINGS' }
  | { type: 'SAVE_SETTINGS'; settings: Partial<OCRSettings> }
  | { type: 'GET_HISTORY' }
  | { type: 'CLEAR_HISTORY' }
  | { type: 'DELETE_ENTRY'; id: string }
  | { type: 'AUTH_STATE' }
  | { type: 'AUTH_SIGN_IN_GOOGLE' }
  | { type: 'AUTH_SEND_LOGIN_EMAIL'; email: string }
  | { type: 'AUTH_LOGIN_WITH_EMAIL'; email: string; code: string }
  | { type: 'AUTH_SIGN_OUT' }
  | { type: 'AUTH_DELETE' }
  | { type: 'SYNC_HISTORY' }
  | { type: 'PDF_EXTRACT'; pdfData: ArrayBuffer; language?: string; mode?: string; name?: string }
  | { type: 'GET_LAST_CONVERT' }
  | { type: 'CONVERT_PROGRESS'; page: number; total: number; ocr: boolean }
  | { type: 'OCR_RUN'; payload: OcrRunPayload };

type ContentRequest =
  | { type: 'START_SELECTION' }
  | { type: 'OCR_DONE'; entry: OCRHistoryEntry }
  | { type: 'OCR_FAILED'; error: string };

interface OkResponse {
  ok: boolean;
  error?: string;
}
