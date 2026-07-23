// Runs in the extension's offscreen document — has SpeechRecognition with
// the extension's own mic permission, not the page's.

let recognition = null;
let isRecording = false;
let finalTranscript = '';

chrome.runtime.onMessage.addListener((msg) => {
  if (msg.target !== 'offscreen') return;

  if (msg.type === 'START_REC') {
    if (isRecording) { recognition?.stop(); return; }

    const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
    if (!SR) {
      chrome.runtime.sendMessage({ type: 'VOICE_REC_ERROR', error: 'Speech recognition not supported' });
      return;
    }

    finalTranscript = '';
    recognition = new SR();
    recognition.continuous = true;
    recognition.interimResults = true;
    recognition.lang = 'en-US';

    recognition.onstart = () => {
      isRecording = true;
      chrome.runtime.sendMessage({ type: 'VOICE_REC_STARTED' });
    };

    recognition.onresult = (ev) => {
      finalTranscript = [...ev.results].map(r => r[0].transcript).join(' ');
    };

    recognition.onend = () => {
      isRecording = false;
      chrome.runtime.sendMessage({ type: 'VOICE_REC_DONE', transcript: finalTranscript });
    };

    recognition.onerror = (e) => {
      isRecording = false;
      chrome.runtime.sendMessage({ type: 'VOICE_REC_ERROR', error: e.error });
    };

    recognition.start();
    return;
  }

  if (msg.type === 'STOP_REC') {
    recognition?.stop();
    return;
  }
});
