import { ToolCall, AppSession } from '@mentra/sdk';
import { EventEmitter } from 'events';

/**
 * Handle a tool call
 * @param toolCall - The tool call from the server
 * @param userId - The user ID of the user who called the tool
 * @param session - The session object if the user has an active session
 * @param internalEvents - Optional internal event emitter for app communication
 * @returns A promise that resolves to the tool call result
 */
export async function handleToolCall(
  toolCall: ToolCall, 
  userId: string, 
  session: AppSession|undefined,
  internalEvents?: EventEmitter
): Promise<string | undefined> {
  console.log(`[ToolCall] Received: ${toolCall.toolId} for user ${userId}`);

  if (toolCall.toolId === "start_recording") {
    if (internalEvents) {
      internalEvents.emit('manual_start_recording', userId);
      return "Manual recording start triggered.";
    }
    return "Internal event system not available.";
  }

  if (toolCall.toolId === "stop_recording") {
    if (internalEvents) {
      internalEvents.emit('manual_stop_recording', userId);
      return "Manual recording stop triggered.";
    }
    return "Internal event system not available.";
  }

  if (toolCall.toolId === "generate_responses") {
    if (internalEvents) {
      internalEvents.emit('generate_responses', userId);
      return "Generating responses...";
    }
    return "Internal event system not available.";
  }

  // Android control tool call coming from Mentra UI buttons
  if (toolCall.toolId === "android_control") {
    if (internalEvents) {
      // Mentra provides button parameters here; support a couple possible shapes.
      const params: any = (toolCall as any).parameters || (toolCall as any).args || {};
      const action = params.action as string | undefined;
      const direction = params.direction as string | undefined;

      if (!action) {
        return "Missing action";
      }

      const number = params.number as number | undefined;
      const language = params.language as string | undefined;
      const code = params.code as string | undefined;

      internalEvents.emit('android_control', { userId, action, direction, number, language, code });
      return `Android control: ${action}${direction ? ` (${direction})` : ''}${number ? ` #${number}` : ''}${language ? ` -> ${language}` : ''}`;
    }
    return "Internal event system not available.";
  }

  // Set language tool call
  if (toolCall.toolId === "set_language") {
    if (internalEvents) {
      const params: any = (toolCall as any).parameters || (toolCall as any).args || {};
      const language = params.language as string | undefined;
      const code = params.code as string | undefined;

      if (!language || !code) {
        return "Missing language or code";
      }

      internalEvents.emit('language_changed', { userId, language, code });
      return `Setting language to ${language} (${code})...`;
    }
    return "Internal event system not available.";
  }

  return undefined;
}
