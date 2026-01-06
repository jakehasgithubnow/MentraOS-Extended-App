export interface AppState {
  lastText: string;
  lastTextTimestamp: number;
  options: { text: string; english: string }[];
  targetLanguage: string; // e.g. "ukrainian"
  targetLanguageCode: string; // e.g. "uk"
}

export const globalState = new Map<string, AppState>();
