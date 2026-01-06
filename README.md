# MentraOS Translation & Response Assistant

This application is a real-time translation and conversation assistant designed for MentraOS glasses. It enables users to hold fluid, natural conversations in foreign languages by combining live heads-up translations with contextually-aware AI response generation.

The core motivation of the app is to bridge the "translation gap" where understanding is only half the battle; the app assists the user in *formulating* and *pronouncing* responses in the target language through automated TTS (Text-to-Speech) on a companion device.

## Core Experience Cycle

1. **Listen**: Incoming audio is captured by the MentraOS glasses and streamed to the server.
2. **Understand**: The server transcribes the foreign language audio via **Deepgram** and provides an English translation via **Groq/Llama**.
3. **View**: The English translation appears instantly on the glasses HUD, allowing the user to follow the conversation.
4. **Respond**: On the user's command (via webview or glasses trigger), the AI analyzes the conversation history to generate 4 likely responses.
5. **Bridge**: While the user is choosing a response, a "filler" phrase (e.g., "Give me a second to think...") is automatically played through a Bluetooth speaker to maintain conversation flow.
6. **Speak**: The user selects a response, and the server sends it to the companion app to be spoken aloud in the target language.

## Key Features

- **Low-Latency Transcription**: Powered by **Deepgram's Nova-2** model, optimized for real-time speech-to-text.
- **Contextual Translation**: Uses **Groq's Llama-3/4** models to provide translations that understand the nuances of the ongoing conversation rather than just literal word substitution.
- **Smart Response Engine**: Generates multiple response options in the target language with English summaries for the user.
- **Transliteration Support**: For languages with non-latin scripts (like Ukrainian), the engine can provide transliterated text to help users who can't read the script.
- **Authenticated Webview**: Provides a secure mobile interface for selecting responses, changing settings, and viewing live logs.
- **Android Integration**: Dedicated webhook support for external TTS playback and hardware button controls (cycling/selecting responses).
- **Session Management**: Handles real-time cleanup and state management for multiple concurrent users.

## Tech Stack

- **Runtime**: [Bun](https://bun.sh/) (for high-performance TypeScript execution)
- **Framework**: Express with EJS for server-side rendered web views
- **SDK**: [@mentra/sdk](https://www.npmjs.com/package/@mentra/sdk) for seamless MenraOS integration
- **AI Models**: 
  - **Deepgram** (ASR)
  - **Groq/Llama** (Translation & Reasoning)
- **Styling**: Tailwind CSS

## Prerequisites

1. **Hardware**: MentraOS Glasses and an Android phone (for companion app/speaker support).
2. **API Keys**:
   - [Deepgram API Key](https://console.deepgram.com/)
   - [Groq API Key](https://console.groq.com/)
   - [MentraOS API Key](https://console.mentra.glass/)
3. **Development Tools**:
   - [Bun](https://bun.sh/docs/installation) installed on your machine.
   - [ngrok](https://ngrok.com/) for exposing your local development server to the internet.

## Installation & Setup

### 1. MentraOS Console Configuration
1. Log in to [console.mentra.glass](https://console.mentra.glass/).
2. Create a new App and register a unique package name (e.g., `com.yourname.assistant`).
3. Note your **API Key** and **Package Name**.
4. Set the **Public URL** to your ngrok forwarding address.
5. **Import Config**: Download the `app_config.json` from this repo and upload it to the "Configuration Management" section in the console to pre-configure your app's tools and settings.

### 2. Local Environment Setup
1. Clone the repo:
   ```bash
   git clone <repo-url>
   cd MentraOS-Extended-Example-App
   ```
2. Install dependencies:
   ```bash
   bun install
   ```
3. Configure Environment Variables:
   ```bash
   cp .env.example .env
   ```
   Modify `.env` with your specific keys:
   ```env
   PORT=3000
   PACKAGE_NAME=com.your.package.name
   MENTRAOS_API_KEY=your_mentra_key
   DEEPGRAM_API_KEY=your_deepgram_key
   GROQ_API_KEY=your_groq_key
   ANDROID_WEBHOOK_URL=http://your-android-ip:port/webhook
   ```

### 3. Launching the App
1. Start the server (with hot-reloading):
   ```bash
   bun run dev
   ```
2. Open a tunnel (match the PORT in your .env):
   ```bash
   ngrok http 3000
   ```

## Detailed Usage Guide

### Using the Webview
Access `https://your-domain.com/webview`. The webview allows you to:
- **Monitor**: See the live transcription and translation logs as they happen.
- **Control**: Trigger the "Generate Responses" action manually.
- **Select**: Tap a generated response to play it through the connected Android device.
- **Settings**: Change the target language dynamically (e.g., from Ukrainian to Spanish).

### Using the Android Companion App
If you have the Android companion app installed:
- Hardware buttons on the phone or glasses can be mapped to **Cycle** (up/down) and **Select**.
- Select a response, and the phone will immediately play the high-quality TTS audio in the target language.

### Customizing Tools
This app includes predefined tools in `src/tools.ts`:
- `initiate_conversation`: Start a new conversation topic.
- `update_target_language`: Switch languages on the fly.
- `generate_responses`: Manually request new AI suggestions.

## Troubleshooting

- **WebSocket Errors**: Ensure your ngrok tunnel is active and the URL matches exactly in the MentraOS Console.
- **Audio Lag**: Check your internet connection; Deepgram and Groq require stable upstream for real-time performance.
- **TTS Not Playing**: Verify the `ANDROID_WEBHOOK_URL` is reachable from your server.

## Deployment to Render

This app is configured for easy deployment on [Render](https://render.com).

### 1. Connect Repository
Create a new **Web Service** on Render and connect your GitHub/GitLab repository.

### 2. Configure Environment
The app will automatically detect the `render.yaml` file. You will need to manually provide the values for the following variables in the Render Dashboard:

- `PACKAGE_NAME`: Your app's unique identifier.
- `MENTRAOS_API_KEY`: From the MentraOS Console.
- `GROQ_API_KEY`: From Groq Console.
- `SPEECHMATICS_API_KEY`: From Speechmatics Console.
- `ELEVENLABS_API_KEY`: From ElevenLabs Console.
- `ANDROID_WEBHOOK_URL`: The public URL of your Android companion app or mock webhook.

### 3. Update MentraOS Console
Once deployed, copy your Render URL (e.g., `https://mentraos-assistant.onrender.com`) and paste it into the **Public URL** field in your app settings at [console.mentra.glass](https://console.mentra.glass/).

## License
ISC
