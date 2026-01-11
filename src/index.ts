import { ToolCall, AppServer, AppSession } from "@mentra/sdk";
import path from "path";
import { EventEmitter } from "events";
import { setupExpressRoutes } from "./webview";
import { handleToolCall } from "./tools";
import Groq from "groq-sdk";
import { RealtimeClient } from "@speechmatics/real-time-client";
import { createSpeechmaticsJWT } from "@speechmatics/auth";
import { globalState, AppState } from "./state";

console.log("-----------------------------------------");
console.log("MENTRAOS AUDIO RECORDER: src/index.ts");
console.log("TIME:", new Date().toISOString());
console.log("-----------------------------------------");

const PACKAGE_NAME = process.env.PACKAGE_NAME ?? (() => { throw new Error("PACKAGE_NAME is not set in .env file"); })();
const MENTRAOS_API_KEY = process.env.MENTRAOS_API_KEY ?? (() => { throw new Error("MENTRAOS_API_KEY is not set in .env file"); })();
const ANDROID_WEBHOOK_URL = process.env.ANDROID_WEBHOOK_URL || "http://localhost:3000/mock-android-webhook";
const GROQ_API_KEY = process.env.GROQ_API_KEY ?? (() => { throw new Error("GROQ_API_KEY is not set in .env file"); })();
const SPEECHMATICS_API_KEY = process.env.SPEECHMATICS_API_KEY ?? (() => { throw new Error("SPEECHMATICS_API_KEY is not set in .env file"); })();
const PORT = parseInt(process.env.PORT || "3000");

/**
 * Speechmatics JWT generation is handled by the official library
 */

// Create a single EventEmitter for the entire application
const internalEvents = new EventEmitter();

const groq = new Groq({ apiKey: GROQ_API_KEY });

class ExampleMentraOSApp extends AppServer {
  private internalEvents = internalEvents;

  constructor() {
    super({
      packageName: PACKAGE_NAME,
      apiKey: MENTRAOS_API_KEY,
      port: PORT,
      publicDir: path.join(__dirname, "../public"),
    });
    setupExpressRoutes(this, internalEvents);
  }

  public userSessionsMap = new Map<string, AppSession>();

  protected async onToolCall(toolCall: ToolCall): Promise<string | undefined> {
    return handleToolCall(toolCall, toolCall.userId, this.userSessionsMap.get(toolCall.userId), internalEvents);
  }

  protected async onSession(session: AppSession, sessionId: string, userId: string): Promise<void> {
    console.log(`[Session] START: ${userId}`);
    this.userSessionsMap.set(userId, session);

    let isSessionClosed = false;
    let lastChunkTime = 0;
    let isRecordingActive = false;
    let isSpeaking = false; 
    let speakingTimeout: any = null;
    let responseTimeout: any = null;
    
    let audioBuffer: Buffer[] = [];
    let smClient: RealtimeClient | null = null;
    let smClientActive = false;

    let conversationContext: { role: "user" | "assistant" | "system", content: string }[] = []; 
    let translationLog: string[] = []; 
    let pendingSource = "";
    let activeOptions: { text: string; english: string }[] = [];
    let currentIndex = 0;
    let isSelectionStarted = false;
    let pendingIntent = "";
    let isGenerating = false;
    let isTranslating = false;
    let currentTranslationId = 0;
    let lastInterimTranslationTime = 0;
    let lastSentToGlasses = "";
    let persistentGlassContent = "";

    const SAMPLE_RATE = 16000;
    const MAX_DISPLAY_CHARS = 120;

    let lastDisplayCallTime = 0;
    const DISPLAY_COOLDOWN_MS = 800;
    const safeShowText = async (text: string, durationMs: number = 15000) => {
      const startTime = Date.now();
      // 0. Primary guard
      if (isSessionClosed || !session) {
        return;
      }

      // 1. Throttle updates
      const timeSinceLastCall = startTime - lastDisplayCallTime;
      if (timeSinceLastCall < DISPLAY_COOLDOWN_MS) {
        // console.log(`[DEBUG] Throttling display update for ${userId}. Called again after ${timeSinceLastCall}ms`);
        return;
      }
      lastDisplayCallTime = startTime;
      
      const maxRetries = 2;
      const retryDelay = 200;

      for (let i = 0; i < maxRetries; i++) {
        // 1. Check if the session object itself has been cleaned up from our tracking
        if (!this.userSessionsMap.has(userId)) {
          isSessionClosed = true;
          return;
        }

        // 2. Access internal WebSocket state across the SDK's known property names (handling minification/obfuscation safely)
        const internalWs = (session as any).ws || (session as any)._ws || (session as any).socket;
        
        // If internalWs is completely missing or null, the connection is gone for good
        if (!internalWs && i === 0) {
            console.warn(`[Display] WebSocket is missing for ${userId}. Suspending display updates.`);
            isSessionClosed = true;
            return;
        }
        
        const readyState = (session as any).readyState ?? internalWs?.readyState;

        // If readyState is 0 (CONNECTING), 2 (CLOSING), or 3 (CLOSED), retry or give up
        if (readyState !== undefined && readyState !== 1) { // 1 is WebSocket.OPEN
          if (readyState === 0 && i < maxRetries - 1) {
            console.log(`[Display] WebSocket still connecting (${readyState}) for ${userId}, retrying...`);
            await new Promise(resolve => setTimeout(resolve, retryDelay));
            if (isSessionClosed) return;
            continue;
          } else {
            console.warn(`[Display] WebSocket state ${readyState} is non-recoverable for ${userId}. Suppression triggered.`);
            isSessionClosed = true;
            return;
          }
        }

        try {
          // 3. Final check before calling potentially throwing SDK layouts
          if (isSessionClosed) return;
          
          const sdkCall = session.layouts.showTextWall(text, { durationMs });
          const timeout = new Promise((_, reject) => setTimeout(() => reject(new Error("SDK_TIMEOUT")), 3000));
          
          await Promise.race([sdkCall, timeout]);
          
          console.log(`[${new Date().toISOString()}] [GLASSES_SCREEN] Displaying (${text.length} chars): "${text.replace(/\n/g, "\\n")}"`);
          return; // Success
        } catch (e: any) {
          if (e.message === "SDK_TIMEOUT") {
            console.error(`[${new Date().toISOString()}] [ERROR] SDK showTextWall timed out for ${userId}`);
            continue; // Try one more time if we have retries
          }
          console.error(`[${new Date().toISOString()}] [DEBUG] Error in safeShowText:`, e);
          const isConnError = e.message?.includes("WebSocket connection not established") || 
                              e.message?.includes("not connected") ||
                              e.message?.includes("not established");
          
          if (isConnError) {
            if (i < maxRetries - 1) {
              console.log(`[Display] WebSocket error for ${userId}, retrying (${i + 1}/${maxRetries})...`);
              await new Promise(resolve => setTimeout(resolve, retryDelay));
              if (isSessionClosed) return;
              continue;
            } else {
              console.log(`[Display] Session disconnected for ${userId} after retries; WebSocket suppressed.`);
              isSessionClosed = true;
            }
          } else {
            console.error(`[Display] Failed to showTextWall for ${userId}: ${e.message}`);
            break;
          }
        }
      }
    };

    let lastDisplayedText = "";
    let lastSpeakerId = "";

    const processTranscription = async (transcript: string, isFinal: boolean, speakerId?: string) => {
      if (isSessionClosed || !transcript || !transcript.trim()) return;

      const speakerLabel = speakerId ? `[${speakerId}] ` : "";
      console.log(`[Speechmatics] [${userId}] RAW: ${speakerLabel}"${transcript}" (isFinal=${isFinal})`);

      const now = Date.now();
      const shouldTranslate = isFinal || (transcript.trim().split(" ").length > 4 && (now - lastInterimTranslationTime > 1200));

      if (shouldTranslate && !isTranslating) {
        try {
          isTranslating = true;
          const myTranslationId = ++currentTranslationId;

          const state = globalState.get(userId);
          const targetLanguageName = state?.targetLanguage || "English";
          const isEnglishToEnglish = targetLanguageName.toLowerCase() === "english";

          let sourceToTranslate = transcript.trim();
          
          if (!isFinal) {
              lastInterimTranslationTime = now;
          }

          let translation = "";

          if (isEnglishToEnglish) {
            translation = sourceToTranslate; 
            if (!isFinal) {
              const displayWithSpeaker = (speakerId && speakerId !== lastSpeakerId) ? `[${speakerId}] ${translation}` : translation;
              await updateDisplayWithLog(persistentGlassContent, displayWithSpeaker);
            }
          } else {
            const contextStr = conversationContext.map(m => 
              `${m.role === 'user' ? 'User' : 'Assistant'}: ${m.content}`
            ).join('\n');

            const messages: any[] = [
                { role: "system", content: `You are a simultaneous interpreter translating ${targetLanguageName} to English.
- Output ONLY the English translation. 
- No explanations, no quotes, no conversational filler.
- Be concise.
Context: ${contextStr}` },
                { role: "user", content: sourceToTranslate }, 
            ];

            const stream = await groq.chat.completions.create({
              messages: messages,
              model: "meta-llama/llama-4-scout-17b-16e-instruct",
              temperature: 0.1,
              stream: true,
            });

            let fullContent = "";
            let lastSentToGlasses = "";
            let lastDisplayUpdateTime = 0;
            
            for await (const chunk of stream) {
              if (myTranslationId !== currentTranslationId || isSessionClosed) break;

              const content = chunk.choices[0]?.delta?.content || "";
              fullContent += content;
              
              const now = Date.now();
              const isEndOfSegment = fullContent.endsWith(".") || fullContent.endsWith("?") || fullContent.endsWith("!");
              const charThreshold = lastSentToGlasses === "" ? 10 : 25; 

              const shouldUpdateDisplay = content && (
                  isEndOfSegment || 
                  fullContent.length > lastSentToGlasses.length + charThreshold ||
                  (now - lastDisplayUpdateTime > 800 && fullContent.length > lastSentToGlasses.length + 5)
              );

              if (shouldUpdateDisplay) {
                  lastDisplayUpdateTime = now;
                  lastSentToGlasses = fullContent;
                  
                  let displayText = persistentGlassContent;
                  if (fullContent.trim()) {
                      if (displayText) displayText += " ";
                      const displayInterim = (speakerId && speakerId !== lastSpeakerId) ? `[${speakerId}] ${fullContent.trim()}` : fullContent.trim();
                      displayText += displayInterim;
                  }
                  
                  if (displayText.length > MAX_DISPLAY_CHARS) {
                      displayText = displayText.substring(displayText.length - MAX_DISPLAY_CHARS);
                  }

                  await safeShowText(displayText, 15000);
                  
                  let state = globalState.get(userId);
                  if (state) {
                      state.lastText = displayText;
                      state.lastTextTimestamp = Date.now();
                  }
              }
            }

            translation = fullContent;
            if (isFinal) {
              console.log(`[${new Date().toISOString()}] [Groq] [${userId}] TRANS: "${translation}"`);
            }
          }

          if (isSessionClosed) return;

          if (isFinal) {
              const finalThought = isEnglishToEnglish ? sourceToTranslate : translation;
              const contextWithSpeaker = speakerId ? `${speakerId}: ${finalThought}` : finalThought;
              
              conversationContext.push({ 
                role: "user", 
                content: contextWithSpeaker
              });

              if (conversationContext.length > 15) {
                conversationContext = conversationContext.slice(conversationContext.length - 15);
              }
              
              translationLog.push(finalThought);
              if (translationLog.length > 8) translationLog.shift();
              
              if (finalThought.trim()) {
                  if (persistentGlassContent) persistentGlassContent += " ";
                  const displayFinal = (speakerId && speakerId !== lastSpeakerId) ? `[${speakerId}] ${finalThought.trim()}` : finalThought.trim();
                  persistentGlassContent += displayFinal;
                  if (speakerId) lastSpeakerId = speakerId;
              }

              if (persistentGlassContent.length > MAX_DISPLAY_CHARS * 2) {
                  persistentGlassContent = persistentGlassContent.substring(persistentGlassContent.length - MAX_DISPLAY_CHARS * 2);
              }

              pendingSource = "";
              lastSentToGlasses = "";
              
              console.log(`[${new Date().toISOString()}] [Commit] Thought finalized. Baseline history updated.`);
              await updateDisplayWithLog(persistentGlassContent, "");
          }

        } catch (e: any) {
          console.error(`[${new Date().toISOString()}] [Groq] Translation failed for ${userId}: ${e?.message || e}`);
          if (isFinal) updateDisplayWithLog("", pendingSource + " " + transcript);
        } finally {
          isTranslating = false;
        }
      }
    };

    const updateDisplayWithLog = async (history: string, current: string) => {
      if (isSessionClosed) return;

      let displayText = history;
      if (current && current.trim()) {
          if (displayText) displayText += " ";
          displayText += current;
      }

      // De-duplication
      if (displayText === lastDisplayedText) return;
      lastDisplayedText = displayText;
      
      // Stationary Tail Clipping: Keep the most recent characters
      if (displayText.length > MAX_DISPLAY_CHARS) {
         displayText = displayText.substring(displayText.length - MAX_DISPLAY_CHARS);
      }

      await safeShowText(displayText, 15000);
      
      // Update SHARED Global State
      let state = globalState.get(userId);
      if (!state) {
        state = { 
          lastText: "", 
          lastTextTimestamp: 0, 
          options: [],
          targetLanguage: "english",
          targetLanguageCode: "en"
        };
        globalState.set(userId, state);
      }
      state.lastText = displayText;
      state.lastTextTimestamp = Date.now();
      globalState.set(userId, state);
      this.internalEvents.emit('state_updated', userId);
      console.log(`[${new Date().toISOString()}] [Sync] Updated shared state for ${userId}: ${displayText.substring(0, 20)}`);
    };

    let isAudioSubscribed = false;
    const startRecording = async () => {
      if (isRecordingActive || isSessionClosed) return;
      let state = globalState.get(userId);
      if (!state) {
        state = { 
          lastText: "", 
          lastTextTimestamp: 0, 
          options: [],
          targetLanguage: "english",
          targetLanguageCode: "en"
        };
        globalState.set(userId, state);
      }
      const languageCode = state.targetLanguageCode;
      
      console.log(`[Speechmatics] Starting transcription for ${userId} in ${languageCode}`);
      isRecordingActive = true;

      smClient = new RealtimeClient({
        url: "wss://eu.rt.speechmatics.com/v2"
      });
      
      smClient.addEventListener("receiveMessage", (event: any) => {
        const message = event.data;
        if (message.message === "AddTranscript" || message.message === "AddPartialTranscript") {
          const transcript = message.metadata?.transcript;
          const isFinal = message.message === "AddTranscript";
          
          let speakerId = "";
          if (message.results && message.results.length > 0) {
            for (const res of message.results) {
              if (res.alternatives && res.alternatives[0]?.speaker) {
                speakerId = res.alternatives[0].speaker;
                break;
              }
            }
          }

          if (transcript && transcript.trim()) {
            processTranscription(transcript, isFinal, speakerId);
          }
        } else if (message.message === "Error") {
          console.error(`[Speechmatics] Error for ${userId}:`, JSON.stringify(message));
        }
      });

      try {
        const jwt = await createSpeechmaticsJWT({
          apiKey: SPEECHMATICS_API_KEY,
          ttl: 3600,
          type: "rt"
        });

        await smClient.start(jwt, {
          transcription_config: { 
            language: languageCode,
            operating_point: "standard",
            diarization: "speaker",
            enable_partials: true,
            max_delay: 1.0,
            transcript_filtering_config: {
              remove_disfluencies: true,
            }
          },
          audio_format: {
            type: "raw",
            encoding: "pcm_s16le",
            sample_rate: SAMPLE_RATE
          }
        });
        smClientActive = true;
        console.log(`[Speechmatics] Connected for ${userId}`);

        if (audioBuffer.length > 0) {
          console.log(`[Speechmatics] Draining ${audioBuffer.length} buffered chunks for ${userId}`);
          for (const chunk of audioBuffer) {
            smClient.sendAudio(chunk);
          }
          audioBuffer = [];
        }
      } catch (e: any) {
        console.error(`[Speechmatics] Failed to start for ${userId}:`, e.message);
        isRecordingActive = false;
      }

      if (!isAudioSubscribed) {
        console.log(`[Session] Subscribing to audio_chunk for ${userId}`);
        (session.subscribe as any)({ stream: "audio_chunk" });
        isAudioSubscribed = true;
      }
    };

    const onInitiateConversation = async ({ userId: bid, text }: { userId: string, text: string }) => {
      if (bid !== userId || isSessionClosed) return;
      
      console.log(`[${new Date().toISOString()}] [Initiate] Starting conversation for ${userId} with context: "${text}"`);
      
      // Save the topic for after the intro is confirmed
      pendingIntent = text;
      
      // Set initial conversation context with the user's intent
      conversationContext = [{ role: "system", content: `The user eventually wants to talk about: ${text}` }];

      // Update state
      let state = globalState.get(userId);
      if (!state) {
        state = { lastText: "", lastTextTimestamp: 0, options: [], targetLanguage: "english", targetLanguageCode: "en" };
        globalState.set(userId, state);
      }
      state.lastText = text;
      state.lastTextTimestamp = Date.now();
      
      // Clear logs
      translationLog = [];
      pendingSource = "";
      persistentGlassContent = "";
      lastSpeakerId = "";
      updateDisplayWithLog("", text);

      if (responseTimeout) { clearTimeout(responseTimeout); responseTimeout = null; }

      // Mandatory Introduction phase - Generate natural variations in the target language
      const targetLanguageName = state.targetLanguage;
      const isEnglish = targetLanguageName.toLowerCase() === "english";
      const transliterationInstruction = isEnglish 
        ? "" 
        : `IMPORTANT: All ${targetLanguageName} output MUST be transliterated into Latin (Roman) characters. `;

      try {
        const systemContent = isEnglish
          ? `You are an expert conversationalist. The user is using an assistive speech device and needs to check if the other person can hear them.
1. Generate 4 natural, friendly variations of: "Hi, I use this device to speak, can you hear and understand me ok?"
2. Provide a short summary for each (max 30 characters) in the 'english' field.

IMPORTANT: Your entire response must be in valid JSON format.
{
  "responses": [{ "text": "...", "english": "..." }]
}`
          : `You are an expert conversationalist. The user is using an assistive speech device and needs to check if the other person can hear them in ${targetLanguageName}.
1. Generate 4 natural, friendly variations of: "Hi, I use this device to speak, can you hear and understand me ok?" in ${targetLanguageName}.
${transliterationInstruction}2. Provide a short English translation for each (max 30 characters) in the 'english' field.

IMPORTANT: Your entire response must be in valid JSON format.
{
  "responses": [{ "text": "...", "english": "..." }]
}`;

        const chatCompletion = await groq.chat.completions.create({
          messages: [{ role: "system", content: systemContent }],
          model: "meta-llama/llama-4-scout-17b-16e-instruct",
          response_format: { type: "json_object" }
        });
        
        const content = chatCompletion.choices[0]?.message?.content || "";
        let parsed = JSON.parse(content);
        const responses = parsed.responses || parsed;

        if (Array.isArray(responses)) {
          // Robust mapping to ensure we get objects with the correct fields
          activeOptions = responses.slice(0, 4).map((r: any) => {
            if (typeof r === "string") return { text: r, english: r };
            return { 
                text: r.text || r.english || r.value || "", 
                english: r.english || r.text || r.value || "" 
            };
          });
          currentIndex = 0;
          isSelectionStarted = false;
          
          const s = globalState.get(userId)!;
          s.options = activeOptions;
          globalState.set(userId, s);
          this.internalEvents.emit('state_updated', userId);

          if (!isSessionClosed) {
            const optionsList = activeOptions.map((opt, i) => i === 0 ? `> ${opt.english} <` : `  ${opt.english}`).join("\n");
            await safeShowText(`Intro:\n${optionsList}`, 30000);

            responseTimeout = setTimeout(async () => {
              if (activeOptions.length > 0) {
                activeOptions = [];
                isSelectionStarted = false;
                const s = globalState.get(userId);
                if (s) { s.options = []; s.lastText = ""; s.lastTextTimestamp = 0; }
                if (!isSessionClosed) updateDisplayWithLog("", "");
              }
              responseTimeout = null;
            }, 30000);
          }
        }
      } catch (e: any) {
        console.error(`[${new Date().toISOString()}] [Groq] Intro generation failed for ${userId}: ${e.message}`);
        // Fallback to English hardcoded if Groq fails
        activeOptions = [{ text: "Hi, I use this device to speak, can you hear and understand me ok?", english: "Check if they can hear you" }];
        const s = globalState.get(userId)!; s.options = activeOptions;
        if (!isSessionClosed) await safeShowText(`Intro:\n1. Can you hear me?`, 30000);
      }
    };
    internalEvents.on("initiate_conversation", onInitiateConversation);

    const onGenerateResponses = async (bid: string) => {
      if (bid !== userId || isSessionClosed || isGenerating) return;
      
      // Perform a pre-check on the session
      const internalWs = (session as any).ws || (session as any)._ws || (session as any).socket;
      const readyState = (session as any).readyState ?? internalWs?.readyState;
      if (readyState !== undefined && readyState !== 1) {
        return;
      }

      if (responseTimeout) {
        clearTimeout(responseTimeout);
        responseTimeout = null;
      }
      isGenerating = true;

      const state = globalState.get(userId);
      const lastText = state?.lastText;
      const lastTimestamp = state?.lastTextTimestamp || 0;
      const targetLanguageName = state?.targetLanguage || "English";

      // Expire text if it's more than 10 seconds old
      const textAge = Date.now() - lastTimestamp;
      if (!lastText || textAge > 10000) {
        console.log(`[${new Date().toISOString()}] [Expiration] Text too old or missing for ${userId}. Age: ${textAge}ms`);
        if (state) {
          state.lastText = "";
          state.lastTextTimestamp = 0;
        }
        return;
      }

      // Clear all old translations from displaying when generating new responses
      // We do this AFTER capturing lastText and verifying its age
      translationLog = [];
      pendingSource = "";
      persistentGlassContent = "";
      lastSentToGlasses = "";

      if (state) {
        state.lastText = "";
        state.lastTextTimestamp = 0;
      }

      if (!isSessionClosed) {
        await safeShowText("...", 1000); // Visual indicator that we're clearing and generating
      }

      try {
        const isEnglish = targetLanguageName.toLowerCase() === "english";
        const transliterationInstruction = isEnglish 
          ? "" 
          : `IMPORTANT: All ${targetLanguageName} output MUST be transliterated into Latin (Roman) characters. `;

        // Persona: I am the user's voice.
        const baseInstructions = `You are the user's casual, natural voice. They are using a speech device to talk to another person face-to-face.
The user relies on these options to steer the conversation, so providing DIVERSE intents is critical. Do not just rephrase the same idea 4 times.

1. Generate 4 natural, engaging responses that offer DIFFERENT directions for the conversation (e.g. Agree, Decline/Alternative, Question, Change Topic).
2. Ensure the tone is casual (use contractions like "I've", "should've").
3. Provide a short English summary for each (max 30 characters) in the 'english' field.
4. Generate a short, natural filler phrase (e.g., "Hmm...", "Let me see...") for the user to say while choosing.

IMPORTANT: Return your response in valid JSON format ONLY.
Match this JSON format:
{ "responses": [{ "text": "...", "english": "..." }], "filler": "..." }`;

        let effectiveSystemContent = isEnglish
          ? baseInstructions
          : `${baseInstructions}\nGenerate responses in ${targetLanguageName}. ${transliterationInstruction}`;

        let lastUserMessage = `The other person just said: "${lastText}". Please generate natural replies for me to say.`;

        if (pendingIntent) {
            console.log(`[${new Date().toISOString()}] [Intent] Transitioning from Intro to Topic: ${pendingIntent}`);
            const topicBase = `You are the user's natural voice. The other person just confirmed they can hear you. 
Now, start the conversation about this topic: "${pendingIntent}".
${baseInstructions}`;
            
            effectiveSystemContent = isEnglish
                ? topicBase
                : `${topicBase}\nGenerate opening lines in ${targetLanguageName}. ${transliterationInstruction}`;
            
            lastUserMessage = `The other person confirmed they can hear me. Now start the topic: ${pendingIntent}`;
            pendingIntent = ""; 
        }

        const messages: any[] = [
            { role: "system", content: effectiveSystemContent },
            ...conversationContext
        ];

        // Only add the statement if it's not already the last thing in context
        const lastInContext = conversationContext[conversationContext.length - 1];
        if (!lastInContext || (lastInContext.content !== lastText && lastInContext.content !== `Responding to: ${lastText}`)) {
            messages.push({ role: "user", content: lastUserMessage });
        } else {
            // Clarify the task even if it is already in context
            messages.push({ role: "user", content: "What are 4 natural things I could say next?" });
        }

        console.log(`[${new Date().toISOString()}] [Groq] REQUEST MESSAGES: ${JSON.stringify(messages, null, 2)}`);

        const chatCompletion = await groq.chat.completions.create({
          messages: messages,
          model: "meta-llama/llama-4-scout-17b-16e-instruct",
          response_format: { type: "json_object" }
        });
        console.log(`[${new Date().toISOString()}] [Groq] FULL RESPONSE: ${JSON.stringify(chatCompletion, null, 2)}`);

        const content = chatCompletion.choices[0]?.message?.content || "";
        console.log(`[${new Date().toISOString()}] [Groq] RAW CONTENT: ${content}`); // DEBUG LOG
        
        let parsed;
        try {
          parsed = JSON.parse(content);
        } catch (e) {
          console.error(`[${new Date().toISOString()}] [Groq] JSON Parse Error:`, e);
          return;
        }
        
        // Handle filler immediately
        if (parsed.filler) {
             console.log(`[${new Date().toISOString()}] [Groq] Filler found: "${parsed.filler}". Marking as speaking and sending webhook to ${ANDROID_WEBHOOK_URL}...`);
             isSpeaking = true;
             if (speakingTimeout) clearTimeout(speakingTimeout);
             speakingTimeout = setTimeout(() => {
               if (isSpeaking) {
                 console.log(`[Mute] Safety timeout reached for ${userId}. Force-resuming transcription.`);
                 isSpeaking = false;
               }
             }, 10000);

             // Send as 'select' action per user requirement to match response format
             const payload = { action: "select", text: parsed.filler };
             
             fetch(ANDROID_WEBHOOK_URL, {
               method: "POST",
               headers: { "Content-Type": "application/json" },
               body: JSON.stringify(payload)
             })
             .then(res => console.log(`[${new Date().toISOString()}] [Android] Filler Webhook Status: ${res.status} ${res.statusText}`))
             .catch(err => console.error(`[${new Date().toISOString()}] [Android] Filler Webhook Error:`, err.message));
        }

        const responses = Array.isArray(parsed) ? parsed : (parsed.responses || Object.values(parsed)[0]);
        
        if (Array.isArray(responses)) {
          // Robust mapping to objects
          activeOptions = responses.slice(0, 4).map((r: any) => {
            if (typeof r === "string") return { text: r, english: r };
            return { 
                text: r.text || r.english || r.value || "", 
                english: r.english || r.text || r.value || "" 
            };
          });
          currentIndex = 0;
          isSelectionStarted = false;
          
          // Update SHARED Global State
          const s = globalState.get(userId) || { 
            lastText: "", 
            lastTextTimestamp: 0, 
            options: [],
            targetLanguage: "english",
            targetLanguageCode: "en"
          };
          s.options = activeOptions;
          globalState.set(userId, s);
          this.internalEvents.emit('state_updated', userId);

          if (!isSessionClosed) {
            // Display 'english' text in glasses
            const optionsList = activeOptions.map((opt, i) => i === 0 ? `> ${opt.english} <` : `  ${opt.english}`).join("\n");
            console.log(`[${new Date().toISOString()}] [Display] Sending options to glasses`);
            await safeShowText(`Choose:\n${optionsList}`, 30000);

            // Set a 10-second timeout to expire responses
            responseTimeout = setTimeout(async () => {
              if (activeOptions.length > 0) {
                console.log(`[${new Date().toISOString()}] [Expiration] Responses expired after 10 seconds for ${userId}`);
                activeOptions = [];
                isSelectionStarted = false;
                
                const s = globalState.get(userId);
                if (s) {
                  s.options = [];
                  s.lastText = "";
                  s.lastTextTimestamp = 0;
                }
                
                translationLog = [];
                pendingSource = "";
                
                if (!isSessionClosed) {
                  await safeShowText("Expired", 1000);
                  setTimeout(() => {
                    if (!isSessionClosed) {
                      updateDisplayWithLog("", "");
                    }
                  }, 1000);
                }
              }
              responseTimeout = null;
            }, 10000);
          }
        }
      } catch (e: any) {
        console.error(`[${new Date().toISOString()}] [Groq] Generation failed for ${userId}: ${e.message}`);
      } finally {
        isGenerating = false;
      }
    };
    internalEvents.on("generate_responses", onGenerateResponses);

    const handleActionedSelection = async (selectedText: string) => {
      if (isSessionClosed || !this.userSessionsMap.has(userId)) {
        console.warn(`[Selection] Ignoring action for ${userId}: session closed/removed.`);
        return;
      }

      // Add selection to conversation context so the AI knows what was said
      conversationContext.push({ role: "assistant", content: selectedText });
      if (conversationContext.length > 10) conversationContext.shift();

      if (responseTimeout) {
        clearTimeout(responseTimeout);
        responseTimeout = null;
      }
      
      console.log(`[${new Date().toISOString()}] [Selection] User ${userId} actioned: ${selectedText}. Marking as speaking.`);
      isSpeaking = true;
      if (speakingTimeout) clearTimeout(speakingTimeout);
      speakingTimeout = setTimeout(() => {
        if (isSpeaking) {
          console.log(`[Mute] Safety timeout reached for ${userId}. Force-resuming transcription.`);
          isSpeaking = false;
        }
      }, 15000); // Selection responses can be longer than fillers

      await safeShowText(`✅ SELECTED:\n${selectedText}`, 3000);

      // Send Webhook to Android App
      const payload = { action: "select", text: selectedText };
      console.log(`[${new Date().toISOString()}] [Android] Sending select webhook to ${ANDROID_WEBHOOK_URL}:`, payload);

      fetch(ANDROID_WEBHOOK_URL, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload)
      })
      .then(res => {
        console.log(`[${new Date().toISOString()}] [Android] Webhook status: ${res.status} ${res.statusText}`);
        if (!res.ok) {
          console.warn(`[${new Date().toISOString()}] [Android] Webhook failed with status ${res.status}`);
        }
      })
      .catch(err => {
        console.error(`[${new Date().toISOString()}] [Android] Webhook Error:`, err.message);
      });
      
      // Clear text and options after selection (User has generated a response)
      activeOptions = [];
      isSelectionStarted = false;
      const s = globalState.get(userId);
      if (s) {
        s.lastText = "";
        s.lastTextTimestamp = 0;
        s.options = []; // Clear options in shared state too
      }
      translationLog = [];
      pendingSource = "";
      persistentGlassContent = "";
      lastSpeakerId = "";
      
      // Immediately go back to listening display
      setTimeout(() => {
        if (!isSessionClosed) {
          updateDisplayWithLog("", "");
        }
      }, 3000);
    };

    const onUserSelection = ({ userId: bid, selection }: { userId: string, selection: string }) => {
      if (bid === userId && !isSessionClosed) {
        handleActionedSelection(selection);
      }
    };
    internalEvents.on("user_selection", onUserSelection);

    const onSpeechFinished = (bid: string) => {
      if (bid === userId) {
        console.log(`[${new Date().toISOString()}] [Mute] Speech finished for ${userId}. Resuming transcription.`);
        isSpeaking = false;
        if (speakingTimeout) {
          clearTimeout(speakingTimeout);
          speakingTimeout = null;
        }
      }
    };
    internalEvents.on("speech_finished", onSpeechFinished);

    const onLanguageChanged = async ({ userId: bid, language, code }: { userId: string, language: string, code: string }) => {
      if (bid !== userId || isSessionClosed) return;
      console.log(`[${new Date().toISOString()}] [Language] Switching ${userId} to ${language} (${code})...`);
      
      if (smClient) {
        await smClient.stopRecognition();
        smClient = null;
        smClientActive = false;
      }

      pendingIntent = "";
      isRecordingActive = false;
      audioBuffer = [];
      await startRecording();
    };
    internalEvents.on("language_changed", onLanguageChanged);

    const onAndroidControl = async ({ userId: bid, action, direction }: { userId: string, action: string, direction?: string }) => {
      if (bid !== userId || isSessionClosed) return;

        if (action === "cycle" && activeOptions.length > 0) {
          isSelectionStarted = true;
          if (direction === "up") { currentIndex = (currentIndex - 1 + activeOptions.length) % activeOptions.length; } 
          else { currentIndex = (currentIndex + 1) % activeOptions.length; }
          // Display 'english' text when cycling
          const optionsList = activeOptions.map((opt, i) => i === currentIndex ? `> ${opt.english} <` : `  ${opt.english}`).join("\n");
          await safeShowText(`Choose:\n${optionsList}`, 10000);
        } else if (action === "select") {
        if (activeOptions.length > 0) {
          // Allow selection even if cycle hasn't been used yet (default to first option)
          const indexToSelect = isSelectionStarted ? currentIndex : 0;
          console.log(`[${new Date().toISOString()}] [Android] 'select' action received. Selecting option ${indexToSelect}.`);
          handleActionedSelection(activeOptions[indexToSelect].text);
        } else if (!isGenerating) {
          // If no options are active, 'select' triggers response generation
          console.log(`[${new Date().toISOString()}] [Android] 'select' action received. Triggering generate_responses (no active options).`);
          internalEvents.emit("generate_responses", userId);
        } else {
          console.log(`[${new Date().toISOString()}] [Android] 'select' received but already generating. Ignoring.`);
        }
      }
    };
    internalEvents.on("android_control", onAndroidControl);

    session.events.onAudioChunk((chunk) => {
      if (chunk.arrayBuffer && isRecordingActive && !isSpeaking) {
        if (smClientActive && smClient) {
          smClient.sendAudio(chunk.arrayBuffer);
        } else {
          audioBuffer.push(Buffer.from(chunk.arrayBuffer));
        }
      }
    });

    // Periodically expire old text
    const expirationInterval = setInterval(() => {
      if (isSessionClosed) return;
      const state = globalState.get(userId);
      if (state && state.lastText && (Date.now() - state.lastTextTimestamp > 10000)) {
        console.log(`[${new Date().toISOString()}] [Expiration] Background cleaning expired text for ${userId}`);
        state.lastText = "";
        state.lastTextTimestamp = 0;
        
        // Update variables and display
        translationLog = [];
        pendingSource = "";
        persistentGlassContent = "";
        lastSpeakerId = "";
        updateDisplayWithLog("", "");
      }
    }, 2000);

    setTimeout(() => !isSessionClosed && startRecording(), 2000);

    this.addCleanupHandler(() => {
      if (isSessionClosed) return;
      isSessionClosed = true;
      console.log(`[Session] END/CLEANUP: ${userId} (sessionId: ${sessionId})`);
      
      if (smClient) { 
        smClient.stopRecognition(); 
        smClient = null; 
        smClientActive = false;
      }
      pendingIntent = "";
      clearInterval(expirationInterval);
      if (speakingTimeout) { clearTimeout(speakingTimeout); speakingTimeout = null; }
      if (responseTimeout) { clearTimeout(responseTimeout); responseTimeout = null; }

      internalEvents.off("generate_responses", onGenerateResponses);
      internalEvents.off("initiate_conversation", onInitiateConversation);
      internalEvents.off("user_selection", onUserSelection);
      internalEvents.off("android_control", onAndroidControl);
      internalEvents.off("speech_finished", onSpeechFinished);
      internalEvents.off("language_changed", onLanguageChanged);
      
      this.userSessionsMap.delete(userId);
      globalState.delete(userId);
    });
  }
}

const app = new ExampleMentraOSApp();
app.start().catch(console.error);
