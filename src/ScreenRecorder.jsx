import React, { useState, useRef, useEffect } from 'react';

const ScreenRecorder = () => {
  const [isRecording, setIsRecording] = useState(false);
  const [videoURL, setVideoURL] = useState(null);
  const [transcript, setTranscript] = useState('');
  const [personalNotes, setPersonalNotes] = useState('');
  const [language, setLanguage] = useState('uk-UA');
  const [openAiKey, setOpenAiKey] = useState(localStorage.getItem('groq_key') || '');
  const [isTranscribing, setIsTranscribing] = useState(false);
  const [isSummarizing, setIsSummarizing] = useState(false);
  const mediaRecorderRef = useRef(null);
  const audioRecorderRef = useRef(null);
  const chunksRef = useRef([]);
  const audioChunksRef = useRef([]);
  const recognitionRef = useRef(null);
  const finalTranscriptRef = useRef('');
  const currentTranscriptRef = useRef('');
  const lastSummarizedLength = useRef(0);
  const [elapsedTime, setElapsedTime] = useState(0);
  const timerRef = useRef(null);
  const [liveSummary, setLiveSummary] = useState('');
  const [finalAiSummary, setFinalAiSummary] = useState('');

  // ── Timer: counts up freely, NO auto-stop ──────────────────────────
  useEffect(() => {
    if (isRecording) {
      timerRef.current = setInterval(() => {
        setElapsedTime((prev) => prev + 1);
      }, 1000);
    } else {
      clearInterval(timerRef.current);
    }
    return () => clearInterval(timerRef.current);
  }, [isRecording]);

  // ── Live Whisper: drain last 15-s window, never accumulate ─────────
  // Each API call only gets ~15 seconds of audio (< 1 MB),
  // so the 25 MB Groq limit is never hit no matter the total duration.
  useEffect(() => {
    let whisperInterval;
    if (isRecording && openAiKey) {
      whisperInterval = setInterval(async () => {
        const pendingChunks = audioChunksRef.current.splice(0); // drain & reset
        if (pendingChunks.length === 0) return;

        try {
          const audioBlob = new Blob(pendingChunks, { type: 'audio/webm' });
          if (audioBlob.size < 1024) return; // skip tiny / silent blobs

          const formData = new FormData();
          formData.append('file', audioBlob, 'audio.webm');
          formData.append('model', 'whisper-large-v3-turbo');

          const response = await fetch('https://api.groq.com/openai/v1/audio/transcriptions', {
            method: 'POST',
            headers: { 'Authorization': `Bearer ${openAiKey}` },
            body: formData
          });

          if (response.ok) {
            const data = await response.json();
            if (data.text && data.text.trim()) {
              const appended = currentTranscriptRef.current
                ? currentTranscriptRef.current + '\n' + data.text
                : data.text;
              currentTranscriptRef.current = appended;
              setTranscript(`[⚡ Groq Whisper (Live)]\n\n${appended}`);
            }
          }
        } catch (error) {
          console.error('Live Whisper Error:', error);
        }
      }, 15000);
    }
    return () => clearInterval(whisperInterval);
  }, [isRecording, openAiKey]);

  // ── Live AI summary every 7 s ──────────────────────────────────────
  useEffect(() => {
    let summaryInterval;
    if (isRecording && openAiKey) {
      summaryInterval = setInterval(async () => {
        const currentText = currentTranscriptRef.current;
        if (currentText.length > lastSummarizedLength.current + 5) {
          try {
            lastSummarizedLength.current = currentText.length;
            const response = await fetch('https://api.groq.com/openai/v1/chat/completions', {
              method: 'POST',
              headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${openAiKey}`
              },
              body: JSON.stringify({
                model: 'llama-3.3-70b-versatile',
                messages: [
                  {
                    role: 'system',
                    content: 'You are an AI meeting advisor. Provide a comprehensive summary and actionable advices/action items for the meeting transcript so far. Format with clear headings and bullet points. Use the same language as the transcript.'
                  },
                  {
                    role: 'user',
                    content: `Transcript:\n${currentText}`
                  }
                ]
              })
            });
            if (response.ok) {
              const data = await response.json();
              if (data.choices && data.choices.length > 0) {
                setLiveSummary(data.choices[0].message.content);
              }
            } else {
              const err = await response.json();
              setLiveSummary(`❌ API Error: ${err.error?.message || response.statusText}`);
            }
          } catch (e) {
            console.error('Live summary error', e);
            setLiveSummary(`❌ Connection Error: ${e.message}`);
          }
        }
      }, 7000);
    }
    return () => clearInterval(summaryInterval);
  }, [isRecording, openAiKey]);

  const startRecording = async () => {
    try {
      const screenStream = await navigator.mediaDevices.getDisplayMedia({
        video: { cursor: 'always' },
        audio: true
      });

      let micStream;
      try {
        micStream = await navigator.mediaDevices.getUserMedia({ audio: true });
      } catch (micErr) {
        console.warn('Microphone access denied or unavailable', micErr);
      }

      const tracks = [
        ...screenStream.getVideoTracks(),
        ...screenStream.getAudioTracks()
      ];
      if (micStream) tracks.push(...micStream.getAudioTracks());
      const combinedStream = new MediaStream(tracks);

      const audioTracks = [];
      if (screenStream.getAudioTracks().length > 0) audioTracks.push(...screenStream.getAudioTracks());
      if (micStream && micStream.getAudioTracks().length > 0) audioTracks.push(...micStream.getAudioTracks());
      const audioOnlyStream = new MediaStream(audioTracks);

      const videoMime = ['video/webm;codecs=vp9,opus', 'video/webm;codecs=vp8,opus', 'video/webm']
        .find(m => MediaRecorder.isTypeSupported(m)) || '';

      mediaRecorderRef.current = new MediaRecorder(combinedStream, {
        ...(videoMime ? { mimeType: videoMime } : {})
      });
      audioRecorderRef.current = new MediaRecorder(audioOnlyStream);

      mediaRecorderRef.current.ondataavailable = (e) => {
        if (e.data.size > 0) chunksRef.current.push(e.data);
      };

      audioRecorderRef.current.ondataavailable = (e) => {
        if (e.data.size > 0) audioChunksRef.current.push(e.data);
      };

      mediaRecorderRef.current.onstop = () => {
        const blob = new Blob(chunksRef.current, { type: 'video/webm' });
        const url = URL.createObjectURL(blob);
        setVideoURL(url);
        chunksRef.current = [];

        combinedStream.getTracks().forEach(t => t.stop());
        screenStream.getTracks().forEach(t => t.stop());
        if (micStream) micStream.getTracks().forEach(t => t.stop());

        setIsRecording(false);
        if (recognitionRef.current) recognitionRef.current.stop();
      };

      audioRecorderRef.current.onstop = async () => {
        const remaining = audioChunksRef.current.splice(0);
        audioChunksRef.current = [];

        if (openAiKey && audioTracks.length > 0 && remaining.length > 0) {
          setIsTranscribing(true);
          try {
            const audioBlob = new Blob(remaining, { type: 'audio/webm' });
            if (audioBlob.size >= 1024) {
              const formData = new FormData();
              formData.append('file', audioBlob, 'audio.webm');
              formData.append('model', 'whisper-large-v3-turbo');

              const response = await fetch('https://api.groq.com/openai/v1/audio/transcriptions', {
                method: 'POST',
                headers: { 'Authorization': `Bearer ${openAiKey}` },
                body: formData
              });

              if (!response.ok) {
                const errData = await response.json();
                throw new Error(errData.error?.message || 'Whisper API Error');
              }

              const data = await response.json();
              if (data.text && data.text.trim()) {
                const appended = currentTranscriptRef.current
                  ? currentTranscriptRef.current + '\n' + data.text
                  : data.text;
                const finalWhisperText = `[Groq Whisper Transcript (Final)]\n\n${appended}`;
                setTranscript(finalWhisperText);
                generateSummary(finalWhisperText);
              } else {
                generateSummary(currentTranscriptRef.current);
              }
            }
          } catch (error) {
            console.error('Whisper Transcription failed:', error);
            alert(`Groq Whisper failed: ${error.message}`);
          } finally {
            setIsTranscribing(false);
          }
        }
      };

      screenStream.getVideoTracks()[0].onended = () => {
        if (mediaRecorderRef.current?.state === 'recording') {
          mediaRecorderRef.current.stop();
        }
      };

      // timeslice=10s keeps video chunks small; audio at 1-s for live Whisper
      mediaRecorderRef.current.start(10000);
      audioRecorderRef.current.start(1000);
      setIsRecording(true);
      setElapsedTime(0);
      setVideoURL(null);
      setTranscript('');
      setLiveSummary('');
      setFinalAiSummary('');
      finalTranscriptRef.current = '';
      currentTranscriptRef.current = '';
      lastSummarizedLength.current = 0;

      if (!openAiKey) {
        const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
        if (SpeechRecognition) {
          recognitionRef.current = new SpeechRecognition();
          recognitionRef.current.continuous = true;
          recognitionRef.current.interimResults = true;
          recognitionRef.current.lang = language;

          recognitionRef.current.onresult = (event) => {
            let interim = '';
            for (let i = event.resultIndex; i < event.results.length; i++) {
              if (event.results[i].isFinal) {
                finalTranscriptRef.current += event.results[i][0].transcript + ' ';
              } else {
                interim += event.results[i][0].transcript;
              }
            }
            const newText = finalTranscriptRef.current + interim;
            setTranscript(newText);
            currentTranscriptRef.current = newText;
          };

          recognitionRef.current.onerror = (event) => {
            console.log('Speech recognition error', event.error);
          };

          recognitionRef.current.start();
        } else {
          console.warn('Speech Recognition not supported in this browser.');
        }
      }
    } catch (err) {
      console.error('Error accessing screen/audio:', err);
      alert('Failed to start recording. Please ensure permissions are granted.');
    }
  };

  const stopRecording = () => {
    if (mediaRecorderRef.current?.state === 'recording') {
      mediaRecorderRef.current.stop();
    }
    if (audioRecorderRef.current?.state === 'recording') {
      audioRecorderRef.current.stop();
    }
  };

  const generateSummary = async (textToSummarize = transcript) => {
    if (!openAiKey) {
      alert('Please enter your Groq API Key to use the AI Summary feature.');
      return;
    }
    if (!textToSummarize) {
      alert('No transcript available to summarize.');
      return;
    }

    setIsSummarizing(true);
    try {
      const response = await fetch('https://api.groq.com/openai/v1/chat/completions', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${openAiKey}`
        },
        body: JSON.stringify({
          model: 'llama-3.3-70b-versatile',
          messages: [
            {
              role: 'system',
              content: 'You are an AI meeting advisor. Given the following transcript, provide a concise summary and actionable advice/action items. Format with clear headings, bullet points, and use the same language as the transcript.'
            },
            {
              role: 'user',
              content: `Transcript:\n${textToSummarize}`
            }
          ]
        })
      });

      if (!response.ok) {
        const errData = await response.json();
        throw new Error(errData.error?.message || 'Chat API Error');
      }

      const data = await response.json();
      setFinalAiSummary(data.choices[0].message.content);
    } catch (error) {
      console.error('Summary generation failed:', error);
      alert(`AI Summary failed: ${error.message}`);
    } finally {
      setIsSummarizing(false);
    }
  };

  const downloadVideo = () => {
    if (!videoURL) return;
    const a = document.createElement('a');
    a.href = videoURL;
    a.download = `screen-recording-${new Date().getTime()}.webm`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
  };

  const downloadTranscript = () => {
    if (!transcript && !personalNotes) return;
    const content = `=== AI Meeting Transcript ===\n\n${transcript}\n\n=== Personal Notes ===\n\n${personalNotes}`;
    const blob = new Blob([content], { type: 'text/plain' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `ai-meeting-notes-${new Date().getTime()}.txt`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
  };

  const formatTime = (s) => {
    const h = Math.floor(s / 3600);
    const m = Math.floor((s % 3600) / 60);
    const sec = s % 60;
    return h > 0
      ? `${h}:${String(m).padStart(2, '0')}:${String(sec).padStart(2, '0')}`
      : `${m}:${String(sec).padStart(2, '0')}`;
  };

  return (
    <div style={{ padding: '40px', maxWidth: '1200px', margin: '0 auto', textAlign: 'center', background: 'var(--bg-primary)', borderRadius: '12px', minHeight: '80vh', display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'flex-start', color: '#fff' }}>
      <h1 style={{ fontSize: '2.5rem', marginBottom: '10px', color: '#fff' }}>🎥 Screen Recorder Pro</h1>
      <p style={{ color: '#94a3b8', fontSize: '1.2rem', fontStyle: 'italic', marginBottom: '10px' }}>"Мама, мама, ми в телевізорі! 📺"</p>
      <p style={{ color: '#cbd5e1', marginBottom: '30px' }}>Record your screen and microphone instantly right from the browser. No installation required.</p>

      <div style={{ marginBottom: '30px', display: 'flex', alignItems: 'center', gap: '15px', flexWrap: 'wrap', justifyContent: 'center' }}>
        <span style={{ color: '#fff', fontWeight: 'bold' }}>AI Language (Live Browser):</span>
        <select
          value={language}
          onChange={(e) => setLanguage(e.target.value)}
          disabled={isRecording}
          style={{ padding: '8px 16px', borderRadius: '8px', background: '#1e293b', color: '#fff', border: '1px solid #475569', outline: 'none' }}
        >
          <option value="uk-UA">🇺🇦 Українська</option>
          <option value="en-US">🇬🇧 English</option>
          <option value="ru-RU">🇷🇺 Русский</option>
        </select>

        <span style={{ color: '#fff', fontWeight: 'bold', marginLeft: '20px' }}>Groq API Key (Free Auto-Detect):</span>
        <div style={{ display: 'flex', flexDirection: 'column', gap: '5px' }}>
          <input
            type="password"
            placeholder="gsk_..."
            value={openAiKey}
            onChange={(e) => {
              setOpenAiKey(e.target.value);
              localStorage.setItem('groq_key', e.target.value);
            }}
            style={{ padding: '8px 16px', borderRadius: '8px', background: '#1e293b', color: '#fff', border: '1px solid #475569', outline: 'none', width: '250px' }}
          />
          <span style={{ color: '#34d399', fontSize: '0.8rem', textAlign: 'left' }}>✅ Unlimited duration — audio sent in 15-second segments</span>
        </div>
      </div>

      <div style={{ display: 'flex', gap: '20px', marginBottom: '40px' }}>
        {!isRecording ? (
          <button
            className="btn-primary"
            style={{ padding: '15px 30px', fontSize: '1.2rem', borderRadius: '50px', display: 'flex', alignItems: 'center', gap: '10px' }}
            onClick={startRecording}
          >
            <span style={{ fontSize: '1.5rem' }}>⏺</span> Start Recording
          </button>
        ) : (
          <button
            className="btn-primary"
            style={{ padding: '15px 30px', fontSize: '1.2rem', borderRadius: '50px', display: 'flex', alignItems: 'center', gap: '10px', background: '#ef4444' }}
            onClick={stopRecording}
          >
            <span style={{ fontSize: '1.5rem' }}>⏹</span> Stop Recording
          </button>
        )}
      </div>

      {isRecording && (
        <div style={{ display: 'flex', alignItems: 'center', gap: '15px', color: '#ef4444', fontWeight: 'bold', fontSize: '1.2rem' }}>
          <div style={{ width: '12px', height: '12px', background: '#ef4444', borderRadius: '50%', animation: 'pulse 1.5s infinite' }}></div>
          Recording in progress...
          <span style={{ background: '#7f1d1d', color: '#fff', padding: '4px 10px', borderRadius: '8px', fontFamily: 'monospace' }}>
            {formatTime(elapsedTime)}
          </span>
          <span style={{ color: '#64748b', fontSize: '0.85rem', fontWeight: 'normal' }}>No time limit ♾️</span>
        </div>
      )}

      {(isRecording || transcript || personalNotes) && (
        <div style={{ display: 'flex', gap: '20px', width: '100%', marginTop: '20px', flexDirection: 'row' }}>

          <div style={{ flex: 1, background: 'rgba(56, 189, 248, 0.1)', border: '1px solid #38bdf8', padding: '20px', borderRadius: '12px', textAlign: 'left', display: 'flex', flexDirection: 'column' }}>
            <h3 style={{ marginBottom: '15px', color: '#38bdf8', display: 'flex', alignItems: 'center', gap: '10px' }}>
              🤖 AI Meeting Advisor (Live Notes)
            </h3>
            <div style={{ flex: 1, minHeight: '300px', maxHeight: '500px', overflowY: 'auto', color: '#fff', fontSize: '1.1rem', lineHeight: '1.6' }}>
              {isTranscribing && (
                <div style={{ color: '#34d399', fontWeight: 'bold', marginBottom: '10px', animation: 'pulse 1.5s infinite' }}>
                  ⏳ Groq Whisper is analyzing the final segment...
                </div>
              )}
              {transcript || <span style={{ color: '#94a3b8' }}>Waiting for speech (Make sure you allow Microphone access)...</span>}
            </div>
          </div>

          <div style={{ flex: 1, background: 'rgba(168, 85, 247, 0.1)', border: '1px solid #a855f7', padding: '20px', borderRadius: '12px', textAlign: 'left', display: 'flex', flexDirection: 'column' }}>
            <h3 style={{ marginBottom: '15px', color: '#a855f7', display: 'flex', alignItems: 'center', gap: '10px' }}>
              ✨ AI Summary & Advices
            </h3>
            <div style={{ flex: 1, minHeight: '300px', maxHeight: '500px', overflowY: 'auto', color: '#fff', fontSize: '1.1rem', lineHeight: '1.6' }}>
              {isRecording && openAiKey && (
                <div style={{ padding: '15px', background: 'rgba(168, 85, 247, 0.15)', borderRadius: '12px', border: '1px solid #a855f7', color: '#e9d5ff', fontSize: '1rem', lineHeight: '1.5' }}>
                  <strong style={{ color: '#d8b4fe', display: 'flex', alignItems: 'center', gap: '8px', marginBottom: '8px' }}>
                    <div style={{ width: '8px', height: '8px', background: '#d8b4fe', borderRadius: '50%', animation: 'pulse 1.5s infinite' }}></div>
                    Live AI Insights:
                  </strong>
                  <div>{liveSummary || <span style={{ color: '#a855f7', fontStyle: 'italic' }}>Listening... Waiting for you to speak to generate live summary.</span>}</div>
                </div>
              )}
              {!isRecording && finalAiSummary && (
                <div style={{ color: '#e9d5ff', whiteSpace: 'pre-wrap' }}>{finalAiSummary}</div>
              )}
              {!isRecording && !finalAiSummary && (
                <span style={{ color: '#94a3b8' }}>AI Summary will appear here after recording...</span>
              )}
            </div>
          </div>

          <div style={{ flex: 1, background: 'rgba(16, 185, 129, 0.1)', border: '1px solid #10b981', padding: '20px', borderRadius: '12px', textAlign: 'left', display: 'flex', flexDirection: 'column' }}>
            <h3 style={{ marginBottom: '15px', color: '#10b981', display: 'flex', alignItems: 'center', gap: '10px' }}>
              📝 My Action Items & Notes
            </h3>
            <textarea
              value={personalNotes}
              onChange={(e) => setPersonalNotes(e.target.value)}
              placeholder="Type your personal notes, insights, or action items here..."
              style={{ flex: 1, minHeight: '300px', maxHeight: '500px', background: 'transparent', border: 'none', color: '#fff', fontSize: '1.1rem', lineHeight: '1.6', outline: 'none', resize: 'none', width: '100%' }}
            />
          </div>

        </div>
      )}

      {videoURL && !isRecording && (
        <div style={{ width: '100%', background: 'var(--bg-secondary)', padding: '20px', borderRadius: '12px', marginTop: '20px' }}>
          <h3 style={{ marginBottom: '15px' }}>Preview & Downloads</h3>
          <video
            src={videoURL}
            controls
            style={{ width: '100%', borderRadius: '8px', marginBottom: '20px', background: '#000' }}
          />
          <div style={{ display: 'flex', gap: '15px' }}>
            <button
              className="btn-primary"
              style={{ padding: '12px 24px', fontSize: '1.1rem', flex: 1, background: '#10b981' }}
              onClick={downloadVideo}
            >
              ⬇ Video (.webm)
            </button>
            <button
              className="btn-primary"
              style={{ padding: '12px 24px', fontSize: '1.1rem', flex: 1, background: '#a855f7' }}
              onClick={generateSummary}
              disabled={!transcript || isSummarizing}
            >
              {isSummarizing ? '⏳ Generating...' : '✨ AI Summary & Advices'}
            </button>
            <button
              className="btn-primary"
              style={{ padding: '12px 24px', fontSize: '1.1rem', flex: 1, background: '#3b82f6' }}
              onClick={downloadTranscript}
              disabled={!transcript && !personalNotes}
            >
              📝 Save Notes (.txt)
            </button>
          </div>
        </div>
      )}
    </div>
  );
};

export default ScreenRecorder;
