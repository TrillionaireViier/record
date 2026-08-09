import React, { useState, useRef, useEffect } from 'react';

const ScreenRecorder = () => {
  const [isRecording, setIsRecording] = useState(false);
  const [videoURL, setVideoURL] = useState(null);
  const [transcript, setTranscript] = useState('');
  const [personalNotes, setPersonalNotes] = useState('');
  const [language, setLanguage] = useState('uk-UA');
  const [openAiKey, setOpenAiKey] = useState(localStorage.getItem('groq_key') || '');
  const [isTranscribing, setIsTranscribing] = useState(false);
  const mediaRecorderRef = useRef(null);
  const audioRecorderRef = useRef(null);
  const chunksRef = useRef([]);
  const audioChunksRef = useRef([]);
  const recognitionRef = useRef(null);
  const finalTranscriptRef = useRef('');
  const [elapsedTime, setElapsedTime] = useState(0);

  useEffect(() => {
    let timer;
    if (isRecording) {
      if (elapsedTime >= 45 * 60) {
        stopRecording(); // Automatically stop recording at 45 mins
      } else {
        timer = setInterval(() => {
          setElapsedTime((prev) => prev + 1);
        }, 1000);
      }
    }
    return () => clearInterval(timer);
  }, [isRecording, elapsedTime]);

  const startRecording = async () => {
    try {
      // 1. Get screen stream (video + system audio if user allows)
      const screenStream = await navigator.mediaDevices.getDisplayMedia({
        video: { cursor: 'always' },
        audio: true
      });

      // 2. Get microphone stream
      let micStream;
      try {
        micStream = await navigator.mediaDevices.getUserMedia({ audio: true });
      } catch (micErr) {
        console.warn("Microphone access denied or unavailable", micErr);
      }

      // 3. Combine tracks
      const tracks = [
        ...screenStream.getVideoTracks(),
        ...screenStream.getAudioTracks()
      ];
      
      if (micStream) {
        tracks.push(...micStream.getAudioTracks());
      }

      const combinedStream = new MediaStream(tracks);

      // 4. Create audio-only stream for Whisper
      const audioTracks = [];
      if (screenStream.getAudioTracks().length > 0) audioTracks.push(...screenStream.getAudioTracks());
      if (micStream && micStream.getAudioTracks().length > 0) audioTracks.push(...micStream.getAudioTracks());
      const audioOnlyStream = new MediaStream(audioTracks);

      mediaRecorderRef.current = new MediaRecorder(combinedStream, {
        mimeType: 'video/webm;codecs=vp9,opus'
      });
      
      // Secondary recorder just for audio (to keep size small for Whisper API)
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
        chunksRef.current = []; // reset
        
        // Stop all tracks (screen and mic)
        combinedStream.getTracks().forEach(track => track.stop());
        screenStream.getTracks().forEach(track => track.stop());
        if (micStream) micStream.getTracks().forEach(track => track.stop());
        
        setIsRecording(false);
        if (recognitionRef.current) {
          recognitionRef.current.stop();
        }
      };
      
      audioRecorderRef.current.onstop = async () => {
        const audioBlob = new Blob(audioChunksRef.current, { type: 'audio/webm' });
        audioChunksRef.current = [];
        
        // If OpenAI Key is provided, use Whisper API for perfect transcription!
        if (openAiKey && audioTracks.length > 0) {
          setIsTranscribing(true);
          try {
            const formData = new FormData();
            formData.append('file', audioBlob, 'audio.webm');
            formData.append('model', 'whisper-large-v3-turbo');
            
            const response = await fetch('https://api.groq.com/openai/v1/audio/transcriptions', {
              method: 'POST',
              headers: {
                'Authorization': `Bearer ${openAiKey}`
              },
              body: formData
            });
            
            if (!response.ok) {
              const errData = await response.json();
              throw new Error(errData.error?.message || 'Whisper API Error');
            }
            
            const data = await response.json();
            // Prepend Whisper results over the browser's live results
            setTranscript(`[Groq Whisper Transcript (Auto-detected)]\n\n${data.text}`);
          } catch (error) {
            console.error('Whisper Transcription failed:', error);
            alert(`Groq Whisper failed: ${error.message}`);
          } finally {
            setIsTranscribing(false);
          }
        }
      };

      // Handle user clicking "Stop sharing" from browser UI (screen stream)
      screenStream.getVideoTracks()[0].onended = () => {
        if (mediaRecorderRef.current.state === 'recording') {
          mediaRecorderRef.current.stop();
        }
      };

      mediaRecorderRef.current.start();
      audioRecorderRef.current.start();
      setIsRecording(true);
      setElapsedTime(0);
      setVideoURL(null); // clear previous
      setTranscript(''); // reset transcript
      finalTranscriptRef.current = ''; // reset final transcript
      
      // Start AI Speech Recognition
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
          setTranscript(finalTranscriptRef.current + interim);
        };
        
        recognitionRef.current.onerror = (event) => {
          console.log('Speech recognition error', event.error);
        };
        
        recognitionRef.current.start();
      } else {
        console.warn("Speech Recognition not supported in this browser.");
      }
    } catch (err) {
      console.error("Error accessing screen/audio:", err);
      alert("Failed to start recording. Please ensure permissions are granted.");
    }
  };

  const stopRecording = () => {
    if (mediaRecorderRef.current && mediaRecorderRef.current.state === 'recording') {
      mediaRecorderRef.current.stop();
    }
    if (audioRecorderRef.current && audioRecorderRef.current.state === 'recording') {
      audioRecorderRef.current.stop();
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

  return (
    <div style={{ padding: '40px', maxWidth: '1200px', margin: '0 auto', textAlign: 'center', background: 'var(--bg-primary)', borderRadius: '12px', minHeight: '80vh', display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'flex-start', color: '#fff' }}>
      <h1 style={{ fontSize: '2.5rem', marginBottom: '10px', color: '#fff' }}>🎥 Screen Recorder Pro</h1>
      <p style={{ color: '#94a3b8', fontSize: '1.2rem', fontStyle: 'italic', marginBottom: '10px' }}>"Мама, мама, ми в телевізорі! 📺"</p>
      <p style={{ color: '#cbd5e1', marginBottom: '30px' }}>Record your screen and microphone instantly right from the browser. No installation required.</p>
      
      <div style={{ marginBottom: '30px', display: 'flex', alignItems: 'center', gap: '15px' }}>
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
          <span style={{ color: '#94a3b8', fontSize: '0.8rem', textAlign: 'left' }}>⚠️ Limit: ~45-60 mins per recording (25MB)</span>
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
        <div style={{ display: 'flex', alignItems: 'center', gap: '15px', color: '#ef4444', fontWeight: 'bold', fontSize: '1.2rem', animation: 'pulse 1.5s infinite' }}>
          <div style={{ width: '12px', height: '12px', background: '#ef4444', borderRadius: '50%' }}></div>
          Recording in progress...
          <span style={{ background: '#7f1d1d', color: '#fff', padding: '4px 10px', borderRadius: '8px', fontFamily: 'monospace' }}>
            {Math.floor(elapsedTime / 60)}:{String(elapsedTime % 60).padStart(2, '0')}
          </span>
        </div>
      )}

      {(isRecording || transcript || personalNotes) && (
        <div style={{ display: 'flex', gap: '20px', width: '100%', marginTop: '20px', flexDirection: 'row' }}>
          
          {/* Left Column: AI Advisor */}
          <div style={{ flex: 1, background: 'rgba(56, 189, 248, 0.1)', border: '1px solid #38bdf8', padding: '20px', borderRadius: '12px', textAlign: 'left', display: 'flex', flexDirection: 'column' }}>
            <h3 style={{ marginBottom: '15px', color: '#38bdf8', display: 'flex', alignItems: 'center', gap: '10px' }}>
              🤖 AI Meeting Advisor (Live Notes)
            </h3>
            <div style={{ flex: 1, minHeight: '300px', maxHeight: '500px', overflowY: 'auto', color: '#fff', fontSize: '1.1rem', lineHeight: '1.6' }}>
              {isTranscribing && (
                <div style={{ color: '#34d399', fontWeight: 'bold', marginBottom: '10px', animation: 'pulse 1.5s infinite' }}>
                  ⏳ Groq Whisper is analyzing and perfecting the transcript at lightning speed...
                </div>
              )}
              {transcript || <span style={{ color: '#94a3b8' }}>Waiting for speech (Make sure you allow Microphone access)...</span>}
            </div>
          </div>

          {/* Right Column: Personal Notes */}
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
