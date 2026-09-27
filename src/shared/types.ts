export interface OCRResult {
  text: string;
  confidence: number;
  timestamp: number;
  language: string;
  imageData?: string;
}

export interface SelectionArea {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface OCRHistoryEntry extends OCRResult {
  id: string;
}

export interface OCRSettings {
  language: string;
  removeLineBreaks: boolean;
  mergeSpaces: boolean;
  outputFormat: 'plain' | 'markdown';
}

export type OCRMessage =
  | { type: 'OCR_START'; payload: { imageData: string; language: string; area?: SelectionArea } }
  | { type: 'OCR_COMPLETE'; payload: OCRResult }
  | { type: 'OCR_ERROR'; payload: { error: string } }
  | { type: 'CAPTURE_VISIBLE_TAB' }
  | { type: 'CROP_IMAGE'; payload: { imageData: string; area: SelectionArea } }
  | { type: 'GET_SETTINGS' }
  | { type: 'SAVE_SETTINGS'; payload: Partial<OCRSettings> }
  | { type: 'GET_HISTORY' }
  | { type: 'SAVE_HISTORY'; payload: OCRHistoryEntry[] }
  | { type: 'CLEAR_HISTORY' };
