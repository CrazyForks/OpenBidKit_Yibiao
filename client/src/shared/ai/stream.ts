import type { AiStreamEvent } from '../types/ai';

export type StreamEventHandler = (event: AiStreamEvent) => void;

export function createTextCollector(onText?: (fullText: string, chunk: string) => void) {
  let fullText = '';

  return {
    handle(event: AiStreamEvent) {
      if (event.type !== 'chunk' || !event.chunk) {
        return;
      }

      fullText += event.chunk;
      onText?.(fullText, event.chunk);
    },
    getText() {
      return fullText;
    },
  };
}
