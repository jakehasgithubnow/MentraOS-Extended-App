import { AuthenticatedRequest, AppServer } from '@mentra/sdk';
import express, { Request, Response, NextFunction } from 'express';
import path from 'path';
import { EventEmitter } from 'events';
import { globalState } from './state';

/**
 * Sets up all Express routes and middleware for the server
 * @param server The server instance
 * @param internalEvents Optional internal event emitter for app communication
 */
export function setupExpressRoutes(server: AppServer, internalEvents?: EventEmitter): void {
  // Get the Express app instance
  const app = server.getExpressApp();

  // Keep track of connected SSE clients
  const sseClients = new Map<string, Response[]>();

  const broadcastState = (userId: string) => {
    const clients = sseClients.get(userId);
    if (!clients) return;

    const state = globalState.get(userId);
    if (!state) return;

    const data = JSON.stringify({
      success: true,
      options: state.options,
      lastText: state.lastText,
      targetLanguage: state.targetLanguage,
      targetLanguageCode: state.targetLanguageCode
    });

    clients.forEach(res => {
      res.write(`data: ${data}\n\n`);
    });
  };

  if (internalEvents) {
    internalEvents.on('state_updated', (userId: string) => {
      broadcastState(userId);
    });
  }

  // Add JSON body parser
  app.use(express.json());

  // Health check endpoint for Render/Cloud deployment
  app.get('/health', (req: Request, res: Response) => {
    res.status(200).json({ status: 'ok', time: new Date().toISOString() });
  });

  // Set up EJS as the view engine
  app.set('view engine', 'ejs');
  app.engine('ejs', require('ejs').__express);
  app.set('views', path.join(__dirname, 'views'));

  // Register a route for handling webview requests
  app.get('/webview', (req: Request, res: Response) => {
    const authReq = req as AuthenticatedRequest;
    // For development/mocking purposes, we can override with query param if not set via header
    const userId = authReq.authUserId || (req.query.userId as string);
    if (userId) {
      // Render the webview template
      res.render('webview', {
        userId: userId,
      });
    } else {
      res.render('webview', {
        userId: undefined,
      });
    }
  });

  // Route for Server-Sent Events
  app.get('/events', (req: Request, res: Response) => {
    const userId = (req.query.userId as string);
    if (!userId) {
      res.status(400).send('Missing userId');
      return;
    }

    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.flushHeaders();

    const clients = sseClients.get(userId) || [];
    clients.push(res);
    sseClients.set(userId, clients);

    // Send initial state
    const state = globalState.get(userId);
    if (state) {
      const data = JSON.stringify({
        success: true,
        options: state.options,
        lastText: state.lastText,
        targetLanguage: state.targetLanguage,
        targetLanguageCode: state.targetLanguageCode
      });
      res.write(`data: ${data}\n\n`);
    }

    req.on('close', () => {
      const currentClients = sseClients.get(userId) || [];
      sseClients.set(userId, currentClients.filter(c => c !== res));
    });
  });

  // Route to get the current options for a user
  app.get('/get-options', (req: Request, res: Response) => {
    const authReq = req as AuthenticatedRequest;
    const userId = authReq.authUserId || (req.query.userId as string);
    
    if (userId) {
      const state = globalState.get(userId);
      if (state) {
        // Expire text if more than 10 seconds old
        const textAge = Date.now() - state.lastTextTimestamp;
        if (state.lastText && textAge > 10000) {
          console.log(`[Expiration] Expiring text in get-options for ${userId}. Age: ${textAge}ms`);
          state.lastText = "";
          state.lastTextTimestamp = 0;
        }

        console.log(`[WebviewPoll] Serving state for ${userId}: ${state.lastText.substring(0, 20)}`);
        res.status(200).json({ 
          success: true, 
          options: state.options, 
          lastText: state.lastText,
          targetLanguage: state.targetLanguage,
          targetLanguageCode: state.targetLanguageCode
        });
      } else {
        res.status(200).json({ success: true, options: [], lastText: "" });
      }
    } else {
      res.status(400).json({ success: false, error: 'Missing userId' });
    }
  });

  // Set target language
  app.post('/set-language', (req: Request, res: Response) => {
    const authReq = req as AuthenticatedRequest;
    const { language, code, userId: bodyUserId } = req.body;
    const userId = authReq.authUserId || bodyUserId;

    if (userId && language && code) {
      console.log(`[Webview] Setting language for ${userId} to ${language} (${code})`);
      const state = globalState.get(userId) || { 
        lastText: "", 
        lastTextTimestamp: 0, 
        options: [], 
        targetLanguage: "english", 
        targetLanguageCode: "en" 
      };
      state.targetLanguage = language;
      state.targetLanguageCode = code;
      
      // Clear current options when language changes to prevent confusion
      state.options = [];
      state.lastText = "";
      state.lastTextTimestamp = 0;

      globalState.set(userId, state);
      
      // Notify back-end components that language has changed (may need to restart recording)
      if (internalEvents) {
        internalEvents.emit('language_changed', { userId, language, code });
      }
      
      res.status(200).json({ success: true });
    } else {
      res.status(400).json({ success: false, error: 'Missing language or code' });
    }
  });

  // Manual trigger for response generation
  app.post('/generate-responses-manual', (req: Request, res: Response) => {
    const authReq = req as AuthenticatedRequest;
    const { userId: bodyUserId } = req.body;
    const userId = authReq.authUserId || bodyUserId;

    if (userId && internalEvents) {
      console.log(`[Webview] Manual response generation requested for ${userId}`);
      internalEvents.emit('generate_responses', userId);
      res.status(200).json({ success: true });
    } else {
      res.status(400).json({ success: false, error: 'Missing userId' });
    }
  });

  // Handle user selection from mobile app
  app.post('/user-selection', (req: Request, res: Response) => {
    const authReq = req as AuthenticatedRequest;
    const { selection, userId: bodyUserId } = req.body;
    const userId = authReq.authUserId || bodyUserId;

    if (userId && selection && internalEvents) {
      console.log(`[Webview] User ${userId} selected: ${selection}`);
      internalEvents.emit('user_selection', { userId, selection });
      res.status(200).json({ success: true });
    } else {
      res.status(400).json({ success: false, error: 'Missing userId or selection' });
    }
  });

  // Handle Android App Control
  app.post(['/cycle-choice', '/android-control'], (req: Request, res: Response) => {
    const authReq = req as AuthenticatedRequest;
    const { action, direction, number, language, code, userId: bodyUserId } = req.body;
    const userId = authReq.authUserId || bodyUserId;

    if (userId && action && internalEvents) {
      console.log(`[Android] User ${userId} action: ${action} ${direction || ''}${number ? ` #${number}` : ''}${language ? ` -> ${language}` : ''}`);
      internalEvents.emit('android_control', { userId, action, direction, number, language, code });
      res.status(200).json({ success: true });
    } else {
      res.status(400).json({ success: false, error: 'Missing userId or action' });
    }
  });

  // Initiate a new conversation based on context
  app.post('/initiate-conversation', (req: Request, res: Response) => {
    const authReq = req as AuthenticatedRequest;
    const { text, userId: bodyUserId } = req.body;
    const userId = authReq.authUserId || bodyUserId;

    if (userId && text && internalEvents) {
      console.log(`[Webview] Initiate conversation for ${userId} with context: ${text}`);
      internalEvents.emit('initiate_conversation', { userId, text });
      res.status(200).json({ success: true });
    } else {
      res.status(400).json({ success: false, error: 'Missing userId or text' });
    }
  });

  // Text-to-Speech (ElevenLabs) proxy for low-latency playback on the phone
  // Usage: GET /tts?text=Hello%20world
  app.get('/tts', async (req: Request, res: Response) => {
    const authReq = req as AuthenticatedRequest;
    const userId = authReq.authUserId || (req.query.userId as string);
    const text = (req.query.text as string | undefined)?.trim();

    if (!text) {
      res.status(400).send('Missing text');
      return;
    }

    const state = userId ? globalState.get(userId) : undefined;
    const targetLanguageCode = state?.targetLanguageCode || 'uk';

    const apiKey = process.env.ELEVENLABS_API_KEY;
    const voiceId = (req.query.voice_id as string | undefined) || process.env.ELEVENLABS_VOICE_ID || 'pNInz6obpgmqS7Pj69Hk';
    
    if (!apiKey) {
      console.error('[TTS] Missing ELEVENLABS_API_KEY');
      res.status(500).send('Server misconfigured: missing ELEVENLABS_API_KEY');
      return;
    }

    // ElevenLabs TTS URL
    // Adding output_format=mp3_44100_128 for consistent quality
    const url = `https://api.elevenlabs.io/v1/text-to-speech/${voiceId}?optimize_streaming_latency=4&output_format=mp3_44100_128`;

    try {
      const elResponse = await fetch(url, {
        method: 'POST',
        headers: {
          'xi-api-key': apiKey,
          'Content-Type': 'application/json',
          'accept': 'audio/mpeg',
        },
        body: JSON.stringify({
          text,
          model_id: 'eleven_turbo_v2_5', // Multilingual, supports many languages, optimized for low latency
          language_code: targetLanguageCode, // Use the selected target language
          seed: 42,
          voice_settings: {
            stability: 0.5,
            similarity_boost: 0.75,
          },
        }),
      });

      if (!elResponse.ok) {
        const errText = await elResponse.text().catch(() => '');
        console.error(`[TTS] ElevenLabs error status=${elResponse.status} body=${errText}`);
        res.status(502).send('ElevenLabs TTS failed');
        return;
      }

      if (!elResponse.body) {
        console.error('[TTS] ElevenLabs response had no body');
        res.status(502).send('ElevenLabs TTS failed (no body)');
        return;
      }

      res.setHeader('Content-Type', 'audio/mpeg');
      console.log(`[TTS] Sending ElevenLabs TTS voiceId=${voiceId} textLen=${text.length}`);

      const audioBuffer = Buffer.from(await elResponse.arrayBuffer());
      res.status(200).send(audioBuffer);
    } catch (e: any) {
      console.error('[TTS] Proxy error', e);
      res.status(500).send('TTS proxy error');
    }
  });

  // Signal from companion app that audio playback has finished
  app.post('/speech-finished', (req: Request, res: Response) => {
    const authReq = req as AuthenticatedRequest;
    const { userId: bodyUserId } = req.body;
    const userId = authReq.authUserId || bodyUserId;

    if (userId && internalEvents) {
      console.log(`[Webview] Speech finished signal received for ${userId}`);
      internalEvents.emit('speech_finished', userId);
      res.status(200).json({ success: true });
    } else {
      res.status(400).json({ success: false, error: 'Missing userId' });
    }
  });

  // Mock Android Webhook for testing
  app.post('/mock-android-webhook', (req: Request, res: Response) => {
    console.log(`[MockAndroid] Received webhook payload:`, req.body);
    res.status(200).json({ received: true });
  });
}
