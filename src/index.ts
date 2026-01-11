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
    const DISPLAY_COOLDOWN_MS = 600;
    const safeShowText = async (text: string, durationMs: number = 15000, force: boolean = false) => {
      const startTime = Date.now();
      if (isSessionClosed || !session) return;

      const timeSinceLastCall = startTime - lastDisplayCallTime;
      if (!force && timeSinceLastCall < DISPLAY_COOLDOWN_MS) return;
      lastDisplayCallTime = startTime;
      
      const maxRetries = 2;
      const retryDelay = 200;

      for (let i = 0; i < maxRetries; i++) {
        if (!this.userSessionsMap.has(userId)) {
          isSessionClosed = true;
          return;
        }

        const internalWs = (session as any).ws || (session as any)._ws || (session as any).socket;
        if (!internalWs && i === 0) {
            console.warn(`[Display] WebSocket is missing for ${userId}`);
            isSessionClosed = true;
            return;
        }
        
        const readyState = (session as any).readyState ?? internalWs?.readyState;
        if (readyState !== undefined && readyState !== 1) {
          if (readyState === 0 && i < maxRetries - 1) {
            await new Promise(resolve => setTimeout(resolve, retryDelay));
            continue;
          } else {
            isSessionClosed = true;
            return;
          }
        }

        try {
          if (isSessionClosed) return;
          await session.layouts.showTextWall(text, { durationMs });
          return; 
        } catch (e: any) {
          console.error(`[Display] Error:`, e.message);
          if (i === maxRetries - 1) isSessionClosed = true;
          await new Promise(resolve => setTimeout(resolve, retryDelay));
        }
      }
    };

    let lastDisplayedText = "";
    let lastSpeakerId = "";

    const processTranscription = async (transcript: string, isFinal: boolean, speakerId?: string) => {
      if (isSessionClosed || !transcript || !transcript.trim()) return;

      const state = globalState.get(userId);
      const targetLanguageName = state?.targetLanguage || "English";
      const isEnglish = targetLanguageName.toLowerCase() === "english";

      const now = Date.now();
      
      if (isEnglish) {
        // English is fast, no need for complex locking
        if (!isFinal) {
          const displayWithSpeaker = (speakerId && speakerId !== lastSpeakerId) ? `[${speakerId}] ${transcript}` : transcript;
          await updateDisplayWithLog(persistentGlassContent, displayWithSpeaker);
        } else {
          const finalThought = transcript.trim();
          const displayFinal = (speakerId && speakerId !== lastSpeakerId) ? `[${speakerId}] ${finalThought}` : finalThought;
          
          if (persistentGlassContent) persistentGlassContent += " ";
          persistentGlassContent += displayFinal;
          if (speakerId) lastSpeakerId = speakerId;

          conversationContext.push({ role: "user", content: speakerId ? `${speakerId}: ${finalThought}` : finalThought });
          if (conversationContext.length > 15) conversationContext.shift();

          await updateDisplayWithLog(persistentGlassContent, "", true);
        }
      } else {
        // Non-English needs LLM translation
        const shouldTranslate = isFinal || (transcript.trim().split(" ").length > 4 && (now - lastInterimTranslationTime > 1500));
        
        if (shouldTranslate && (!isTranslating || isFinal)) {
          const myTranslationId = isFinal ? 999999 : ++currentTranslationId;
          if (!isFinal) isTranslating = true;

          try {
            if (!isFinal) lastInterimTranslationTime = now;

            const contextStr = conversationContext.map(m => `${m.role === 'user' ? 'User' : 'Assistant'}: ${m.content}`).join('\n');
            const stream = await groq.chat.completions.create({
              messages: [
                { role: "system", content: `Simultaneous interpreter ${targetLanguageName} -> English. Concise, ONLY translation. Context: ${contextStr}` },
                { role: "user", content: transcript }
              ],
              model: "meta-llama/llama-4-scout-17b-16e-instruct",
              temperature: 0.1,
              stream: true,
            });

            let fullContent = "";
            let lastUpdateLength = 0;

            for await (const chunk of stream) {
              if (isSessionClosed || (!isFinal && myTranslationId !== currentTranslationId)) break;
              const content = chunk.choices[0]?.delta?.content || "";
              fullContent += content;
              
              if (fullContent.length > lastUpdateLength + 15 || fullContent.endsWith(".") || fullContent.endsWith("?")) {
                lastUpdateLength = fullContent.length;
                const displayWithSpeaker = (speakerId && speakerId !== lastSpeakerId) ? `[${speakerId}] ${fullContent}` : fullContent;
                await updateDisplayWithLog(persistentGlassContent, displayWithSpeaker, fullContent.endsWith("."));
              }
            }

            if (isFinal) {
              const finalThought = fullContent.trim();
              const displayFinal = (speakerId && speakerId !== lastSpeakerId) ? `[${speakerId}] ${finalThought}` : finalThought;
              
              if (persistentGlassContent) persistentGlassContent += " ";
              persistentGlassContent += displayFinal;
              if (speakerId) lastSpeakerId = speakerId;

              conversationContext.push({ role: "user", content: speakerId ? `${speakerId}: ${finalThought}` : finalThought });
              if (conversationContext.length > 15) conversationContext.shift();

              await updateDisplayWithLog(persistentGlassContent, "", true);
            }
          } catch (e: any) {
            console.error(`[Translation] Error:`, e.message);
          } finally {
            if (!isFinal) isTranslating = false;
          }
        }
      }
    };

    const updateDisplayWithLog = async (history: string, current: string, force: boolean = false) => {
      if (isSessionClosed) return;
      let displayText = history;
      if (current && current.trim()) {
          if (displayText) displayText += " ";
          displayText += current.trim();
      }

      if (!force && displayText === lastDisplayedText) return;
      lastDisplayedText = displayText;
      
      if (displayText.length > MAX_DISPLAY_CHARS) {
         displayText = displayText.substring(displayText.length - MAX_DISPLAY_CHARS);
      }

      if (displayText || force) {
        await safeShowText(displayText, 15000, force);
      }

      let state = globalState.get(userId);
      if (!state) {
        state = { lastText: "", lastTextTimestamp: 0, options: [], targetLanguage: "english", targetLanguageCode: "en" };
        globalState.set(userId, state);
      }
      state.lastText = displayText;
      state.lastTextTimestamp = Date.now();
      this.internalEvents.emit('state_updated', userId);
    };

    const startRecording = async () => {
      if (isRecordingActive || isSessionClosed) return;
      let state = globalState.get(userId);
      if (!state) {
        state = { lastText: "", lastTextTimestamp: 0, options: [], targetLanguage: "english", targetLanguageCode: "en" };
        globalState.set(userId, state);
      }
      const languageCode = state.targetLanguageCode;
      
      console.log(`[Speechmatics] Start: ${userId} (${languageCode})`);
      isRecordingActive = true;
      smClient = new RealtimeClient({ url: "wss://eu.rt.speechmatics.com/v2" });
      
      smClient.addEventListener("receiveMessage", (event: any) => {
        const message = event.data;
        if (message.message === "AddTranscript" || message.message === "AddPartialTranscript") {
          const transcript = message.metadata?.transcript;
          const isFinal = message.message === "AddTranscript";
          let speakerId = "";
          if (message.results) {
            for (const res of message.results) {
              if (res.alternatives?.[0]?.speaker) {
                speakerId = res.alternatives[0].speaker;
                break;
              }
            }
          }
          if (transcript?.trim()) processTranscription(transcript, isFinal, speakerId);
        }
      });

      try {
        const jwt = await createSpeechmaticsJWT({ apiKey: SPEECHMATICS_API_KEY, ttl: 3600, type: "rt" });
        await smClient.start(jwt, {
          transcription_config: { language: languageCode, operating_point: "standard", diarization: "speaker", enable_partials: true, max_delay: 1.0, transcript_filtering_config: { remove_disfluencies: true } },
          audio_format: { type: "raw", encoding: "pcm_s16le", sample_rate: SAMPLE_RATE }
        });
        smClientActive = true;
        if (audioBuffer.length > 0) {
          for (const chunk of audioBuffer) smClient.sendAudio(chunk);
          audioBuffer = [];
        }
      } catch (e: any) {
        console.error(`[Speechmatics] Start failed:`, e.message);
        isRecordingActive = false;
      }
      (session.subscribe as any)({ stream: "audio_chunk" });
    };

    const onInitiateConversation = async ({ userId: bid, text }: { userId: string, text: string }) => {
      if (bid !== userId || isSessionClosed) return;
      pendingIntent = text;
      conversationContext = [{ role: "system", content: `User wants to talk about: ${text}` }];
      persistentGlassContent = "";
      lastSpeakerId = "";
      updateDisplayWithLog("", text, true);
      
      const state = globalState.get(userId);
      const targetLanguageName = state?.targetLanguage || "English";
      const isEnglish = targetLanguageName.toLowerCase() === "english";

      try {
        const chatCompletion = await groq.chat.completions.create({
          messages: [{ role: "system", content: `Expert conversationalist. Generate 4 natural friendly variations of: "Hi, I use this device to speak, can you hear me ok?" in ${targetLanguageName}. Summary max 30 chars. JSON format: { "responses": [{ "text": "...", "english": "..." }] }` }],
          model: "meta-llama/llama-4-scout-17b-16e-instruct",
          response_format: { type: "json_object" }
        });
        const responses = JSON.parse(chatCompletion.choices[0]?.message?.content || "{}").responses;
        if (Array.isArray(responses)) {
          activeOptions = responses.slice(0, 4).map((r: any) => ({ text: r.text || r.english, english: r.english || r.text }));
          const s = globalState.get(userId)!;
          s.options = activeOptions;
          this.internalEvents.emit('state_updated', userId);
          const optionsList = activeOptions.map((opt, i) => i === 0 ? `> ${opt.english} <` : `  ${opt.english}`).join("\n");
          await safeShowText(`Intro:\n${optionsList}`, 30000, true);
        }
      } catch (e: any) {
        console.error(`[Groq] Intro failed:`, e.message);
      }
    };
    internalEvents.on("initiate_conversation", onInitiateConversation);

    const onGenerateResponses = async (bid: string) => {
      if (bid !== userId || isSessionClosed || isGenerating) return;
      isGenerating = true;
      const state = globalState.get(userId);
      const lastText = state?.lastText;
      if (!lastText || (Date.now() - (state?.lastTextTimestamp || 0) > 10000)) {
        isGenerating = false;
        return;
      }

      try {
        const targetLanguageName = state?.targetLanguage || "English";
        const isEnglish = targetLanguageName.toLowerCase() === "english";
        const chatCompletion = await groq.chat.completions.create({
          messages: [
            { role: "system", content: `Generate 4 natural casual directions for: "${lastText}" in ${targetLanguageName}. Also a short filler phrase. JSON format: { "responses": [{ "text": "...", "english": "..." }], "filler": "..." }` },
            ...conversationContext
          ],
          model: "meta-llama/llama-4-scout-17b-16e-instruct",
          response_format: { type: "json_object" }
        });
        const parsed = JSON.parse(chatCompletion.choices[0]?.message?.content || "{}");
        if (parsed.filler) {
             isSpeaking = true;
             fetch(ANDROID_WEBHOOK_URL, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action: "select", text: parsed.filler }) }).catch(() => {});
        }
        const responses = parsed.responses;
        if (Array.isArray(responses)) {
          activeOptions = responses.slice(0, 4).map((r: any) => ({ text: r.text || r.english, english: r.english || r.text }));
          const s = globalState.get(userId)!;
          s.options = activeOptions;
          this.internalEvents.emit('state_updated', userId);
          const optionsList = activeOptions.map((opt, i) => i === 0 ? `> ${opt.english} <` : `  ${opt.english}`).join("\n");
          await safeShowText(`Choose:\n${optionsList}`, 30000, true);
        }
      } finally {
        isGenerating = false;
      }
    };
    internalEvents.on("generate_responses", onGenerateResponses);

    const handleActionedSelection = async (selectedText: string) => {
      if (isSessionClosed) return;
      conversationContext.push({ role: "assistant", content: selectedText });
      if (conversationContext.length > 10) conversationContext.shift();
      isSpeaking = true;
      await safeShowText(`✅ SELECTED:\n${selectedText}`, 3000, true);
      fetch(ANDROID_WEBHOOK_URL, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action: "select", text: selectedText }) }).catch(() => {});
      activeOptions = [];
      const s = globalState.get(userId);
      if (s) { s.lastText = ""; s.options = []; }
      persistentGlassContent = "";
      lastSpeakerId = "";
      setTimeout(() => !isSessionClosed && updateDisplayWithLog("", "", true), 3000);
    };

    internalEvents.on("user_selection", ({ userId: bid, selection }) => bid === userId && handleActionedSelection(selection));
    internalEvents.on("speech_finished", (bid) => bid === userId && (isSpeaking = false));
    internalEvents.on("language_changed", async ({ userId: bid, language, code }) => {
      if (bid !== userId) return;

      let state = globalState.get(userId);
      if (!state) {
        state = { lastText: "", lastTextTimestamp: 0, options: [], targetLanguage: "english", targetLanguageCode: "en" };
        globalState.set(userId, state);
      }

      if (language && code) {
        state.targetLanguage = language;
        state.targetLanguageCode = code;
        state.options = [];
        state.lastText = "";
        state.lastTextTimestamp = 0;
        this.internalEvents.emit('state_updated', userId);
        await safeShowText(`🌍 Language: ${language}`, 5000, true);
      }

      if (smClient) {
        try {
          await smClient.stopRecognition();
        } catch (e) {}
      }
      smClient = null; smClientActive = false; isRecordingActive = false;
      await startRecording();
    });

    internalEvents.on("android_control", async ({ userId: bid, action, direction, number, language, code }) => {
      if (bid !== userId || isSessionClosed) return;
      if (action === "cycle" && activeOptions.length > 0) {
        isSelectionStarted = true;
        if (direction === "up") currentIndex = (currentIndex - 1 + activeOptions.length) % activeOptions.length;
        else currentIndex = (currentIndex + 1) % activeOptions.length;
        const optionsList = activeOptions.map((opt, i) => i === currentIndex ? `> ${opt.english} <` : `  ${opt.english}`).join("\n");
        await safeShowText(`Choose:\n${optionsList}`, 10000, true);
      } else if (action === "select") {
        if (activeOptions.length > 0) handleActionedSelection(activeOptions[isSelectionStarted ? currentIndex : 0].text);
        else if (!isGenerating) internalEvents.emit("generate_responses", userId);
      } else if (action === "number" && number !== undefined) {
        const idx = number - 1;
        if (activeOptions.length > idx && idx >= 0) {
          handleActionedSelection(activeOptions[idx].text);
        }
      } else if (action === "language") {
        internalEvents.emit("language_changed", { userId, language, code });
      }
    });

    session.events.onAudioChunk((chunk) => {
      if (chunk.arrayBuffer && isRecordingActive && !isSpeaking) {
        if (smClientActive && smClient) smClient.sendAudio(chunk.arrayBuffer);
        else audioBuffer.push(Buffer.from(chunk.arrayBuffer));
      }
    });

    const expirationInterval = setInterval(() => {
      if (isSessionClosed) return;
      const state = globalState.get(userId);
      if (state?.lastText && (Date.now() - state.lastTextTimestamp > 10000)) {
        state.lastText = "";
        persistentGlassContent = "";
        lastSpeakerId = "";
        updateDisplayWithLog("", "", true);
      }
    }, 2000);

    setTimeout(() => !isSessionClosed && startRecording(), 2000);
    this.addCleanupHandler(() => {
      isSessionClosed = true;
      if (smClient) smClient.stopRecognition();
      clearInterval(expirationInterval);
      this.userSessionsMap.delete(userId);
      globalState.delete(userId);
    });
  }
}

const app = new ExampleMentraOSApp();
app.start().catch(console.error);
