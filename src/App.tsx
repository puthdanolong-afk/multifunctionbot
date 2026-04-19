import { useEffect, useState } from 'react';
import { Bot, CheckCircle2, AlertCircle, KeyRound, MessageSquare, Image as ImageIcon, FileText, Video, Mic, ChevronDown, Command, LayoutDashboard, Settings } from 'lucide-react';
import AdminDashboard from './AdminDashboard';

export default function App() {
  const [status, setStatus] = useState<{ botRunning: boolean; hasToken: boolean; hasCobaltKey?: boolean } | null>(null);
  const [openAccordion, setOpenAccordion] = useState<number | null>(null);
  const [activeTab, setActiveTab] = useState<'status' | 'admin'>('status');

  useEffect(() => {
    fetch('/api/status')
      .then((res) => res.json())
      .then((data) => setStatus(data))
      .catch((err) => console.error('Failed to fetch status', err));
  }, []);

  const botCommands = [
    {
      command: "Send Photo",
      description: "Send any image to the bot. It will use Gemini AI to analyze the image, extract text (OCR), and provide a description."
    },
    {
      command: "Send Document (PDF)",
      description: "Upload a PDF document. The bot will extract and read the text content from the file."
    },
    {
      command: "Send Voice/Audio",
      description: "Record a voice message or send an audio file. The bot will transcribe the audio to text (supports Khmer and English)."
    },
    {
      command: "/tts [text]",
      description: "Text-to-Speech. Type /tts followed by your text, and the bot will generate a voice message reading that text."
    },
    {
      command: "Send Video Link",
      description: "Paste a link from YouTube, TikTok, Instagram, Facebook, or Threads. The bot will download and send the video directly to you. If the video is too large, it will offer to send it as a compressed zip file."
    },
    {
      command: "Send Text",
      description: "Chat naturally with the bot. It uses Gemini AI to answer questions, translate, or help with tasks."
    }
  ];

  const toggleAccordion = (index: number) => {
    setOpenAccordion(openAccordion === index ? null : index);
  };

  return (
    <div className="min-h-screen bg-gray-50 text-gray-900 font-sans">
      <div className="max-w-4xl mx-auto p-6 py-12">
        <header className="flex flex-col sm:flex-row sm:items-center justify-between gap-4 mb-10">
          <div className="flex items-center gap-4">
            <div className="bg-blue-600 p-3 rounded-xl text-white">
              <Bot size={32} />
            </div>
            <div>
              <h1 className="text-3xl font-bold text-gray-900">Telegram AI Bot</h1>
              <p className="text-gray-500 mt-1">Multifunctional bot with Gemini AI & Video Downloader</p>
            </div>
          </div>
          
          <div className="flex bg-gray-200/50 p-1 rounded-xl w-fit">
            <button 
              onClick={() => setActiveTab('status')}
              className={`flex items-center gap-2 px-4 py-2 rounded-lg text-sm font-medium transition-all ${activeTab === 'status' ? 'bg-white text-blue-600 shadow-sm' : 'text-gray-600 hover:text-gray-900'}`}
            >
              <Settings size={16} />
              Status
            </button>
            <button 
              onClick={() => setActiveTab('admin')}
              className={`flex items-center gap-2 px-4 py-2 rounded-lg text-sm font-medium transition-all ${activeTab === 'admin' ? 'bg-white text-blue-600 shadow-sm' : 'text-gray-600 hover:text-gray-900'}`}
            >
              <LayoutDashboard size={16} />
              Admin
            </button>
          </div>
        </header>

        {activeTab === 'admin' ? (
          <AdminDashboard />
        ) : (
          <>
            <div className="grid md:grid-cols-2 gap-8">
              <div className="space-y-6">
            <section className="bg-white p-6 rounded-2xl shadow-sm border border-gray-100">
              <h2 className="text-xl font-semibold mb-4 flex items-center gap-2">
                <KeyRound className="text-blue-500" size={20} />
                Bot Status
              </h2>
              
              {status === null ? (
                <div className="animate-pulse flex space-x-4">
                  <div className="flex-1 space-y-4 py-1">
                    <div className="h-4 bg-gray-200 rounded w-3/4"></div>
                  </div>
                </div>
              ) : (
                <div className="space-y-4">
                  <div className="flex items-center justify-between p-4 bg-gray-50 rounded-xl">
                    <span className="font-medium text-gray-700">TELEGRAM_BOT_TOKEN</span>
                    {status.hasToken ? (
                      <span className="flex items-center gap-1.5 text-green-600 font-medium text-sm bg-green-50 px-3 py-1 rounded-full">
                        <CheckCircle2 size={16} /> Provided
                      </span>
                    ) : (
                      <span className="flex items-center gap-1.5 text-red-600 font-medium text-sm bg-red-50 px-3 py-1 rounded-full">
                        <AlertCircle size={16} /> Missing
                      </span>
                    )}
                  </div>

                  <div className="flex items-center justify-between p-4 bg-gray-50 rounded-xl">
                    <span className="font-medium text-gray-700">COBALT_API_KEY</span>
                    {status.hasCobaltKey ? (
                      <span className="flex items-center gap-1.5 text-green-600 font-medium text-sm bg-green-50 px-3 py-1 rounded-full">
                        <CheckCircle2 size={16} /> Provided
                      </span>
                    ) : (
                      <span className="flex items-center gap-1.5 text-yellow-600 font-medium text-sm bg-yellow-50 px-3 py-1 rounded-full">
                        <AlertCircle size={16} /> Missing (Optional)
                      </span>
                    )}
                  </div>
                  
                  <div className="flex items-center justify-between p-4 bg-gray-50 rounded-xl">
                    <span className="font-medium text-gray-700">Bot Service</span>
                    {status.botRunning ? (
                      <span className="flex items-center gap-1.5 text-green-600 font-medium text-sm bg-green-50 px-3 py-1 rounded-full">
                        <CheckCircle2 size={16} /> Running
                      </span>
                    ) : (
                      <span className="flex items-center gap-1.5 text-red-600 font-medium text-sm bg-red-50 px-3 py-1 rounded-full">
                        <AlertCircle size={16} /> Stopped
                      </span>
                    )}
                  </div>
                </div>
              )}

              {status && !status.hasToken && (
                <div className="mt-6 bg-blue-50 border border-blue-100 p-4 rounded-xl text-sm text-blue-800">
                  <p className="font-semibold mb-2">How to start the bot:</p>
                  <ol className="list-decimal list-inside space-y-1.5">
                    <li>Open Telegram and search for <strong>@BotFather</strong></li>
                    <li>Send <code className="bg-blue-100 px-1 rounded">/newbot</code> and follow instructions</li>
                    <li>Copy the HTTP API Token provided</li>
                    <li>Open the <strong>Settings / Secrets</strong> panel in AI Studio</li>
                    <li>Add a new secret named <strong>TELEGRAM_BOT_TOKEN</strong> and paste the token</li>
                  </ol>
                </div>
              )}

              {status && !status.hasCobaltKey && (
                <div className="mt-6 bg-yellow-50 border border-yellow-100 p-4 rounded-xl text-sm text-yellow-800">
                  <p className="font-semibold mb-2 flex items-center gap-1.5">
                    <AlertCircle size={16} /> 
                    Video Downloader Setup
                  </p>
                  <p className="mb-2">To download videos from Instagram, Facebook, and Threads, you need a Cobalt API Key.</p>
                  <ol className="list-decimal list-inside space-y-1.5 mb-3">
                    <li>Host your own Cobalt instance or get access to one.</li>
                    <li>Read the <a href="https://github.com/imputnet/cobalt/blob/main/docs/api.md" target="_blank" rel="noopener noreferrer" className="text-blue-600 hover:underline font-medium">Cobalt API Documentation</a>.</li>
                    <li>Open the <strong>Settings / Secrets</strong> panel in AI Studio.</li>
                    <li>Add a new secret named <strong>COBALT_API_KEY</strong> and paste your key.</li>
                  </ol>
                </div>
              )}
            </section>

            <section className="bg-white p-6 rounded-2xl shadow-sm border border-gray-100">
              <h2 className="text-xl font-semibold mb-4 flex items-center gap-2">
                <MessageSquare className="text-blue-500" size={20} />
                Features
              </h2>
              <ul className="space-y-4">
                <li className="flex gap-3">
                  <div className="bg-purple-100 text-purple-600 p-2 rounded-lg h-fit">
                    <ImageIcon size={20} />
                  </div>
                  <div>
                    <h3 className="font-medium text-gray-900">Image & PDF OCR</h3>
                    <p className="text-sm text-gray-500">Send any image or PDF to extract text automatically.</p>
                  </div>
                </li>
                <li className="flex gap-3">
                  <div className="bg-green-100 text-green-600 p-2 rounded-lg h-fit">
                    <Mic size={20} />
                  </div>
                  <div>
                    <h3 className="font-medium text-gray-900">Voice to Text</h3>
                    <p className="text-sm text-gray-500">Forward or record a voice message/MP3 to transcribe it (Khmer & English).</p>
                  </div>
                </li>
                <li className="flex gap-3">
                  <div className="bg-orange-100 text-orange-600 p-2 rounded-lg h-fit">
                    <FileText size={20} />
                  </div>
                  <div>
                    <h3 className="font-medium text-gray-900">Text to Voice</h3>
                    <p className="text-sm text-gray-500">Use <code className="bg-gray-100 px-1 rounded text-xs">/tts [text]</code> to generate speech from text.</p>
                  </div>
                </li>
                <li className="flex gap-3">
                  <div className="bg-pink-100 text-pink-600 p-2 rounded-lg h-fit">
                    <Video size={20} />
                  </div>
                  <div>
                    <h3 className="font-medium text-gray-900">Video Downloader</h3>
                    <p className="text-sm text-gray-500">Send a link from YouTube, TikTok, Instagram, Facebook, or Threads to download the video.</p>
                  </div>
                </li>
              </ul>
            </section>
          </div>

          <div className="bg-gray-900 rounded-2xl p-6 text-gray-300 font-mono text-sm shadow-xl flex flex-col h-[600px]">
            <div className="flex items-center gap-2 mb-4 pb-4 border-b border-gray-700">
              <div className="w-3 h-3 rounded-full bg-red-500"></div>
              <div className="w-3 h-3 rounded-full bg-yellow-500"></div>
              <div className="w-3 h-3 rounded-full bg-green-500"></div>
              <span className="ml-2 text-gray-400">bot-terminal</span>
            </div>
            <div className="flex-1 overflow-y-auto space-y-2">
              <p className="text-blue-400">$ initializing bot services...</p>
              {status?.hasToken ? (
                <>
                  <p className="text-green-400">✓ TELEGRAM_BOT_TOKEN loaded</p>
                  {status?.hasCobaltKey ? (
                    <p className="text-green-400">✓ COBALT_API_KEY loaded</p>
                  ) : (
                    <p className="text-yellow-400">! COBALT_API_KEY missing (Video DL limited)</p>
                  )}
                  <p className="text-green-400">✓ Gemini AI initialized</p>
                  <p className="text-green-400">✓ Connected to Telegram API</p>
                  <p className="text-white mt-4">Bot is online and listening for messages.</p>
                  <p className="text-gray-500 mt-2">Ready to process:</p>
                  <ul className="list-disc list-inside text-gray-400 ml-2">
                    <li>Photos & PDFs (OCR)</li>
                    <li>Voice messages (STT)</li>
                    <li>/tts commands (TTS)</li>
                    <li>Social media links (Video DL)</li>
                  </ul>
                </>
              ) : (
                <>
                  <p className="text-red-400">✗ TELEGRAM_BOT_TOKEN not found</p>
                  <p className="text-yellow-400 mt-2">Waiting for token configuration...</p>
                </>
              )}
            </div>
          </div>
        </div>

        <section className="mt-8 bg-white p-6 rounded-2xl shadow-sm border border-gray-100">
          <h2 className="text-xl font-semibold mb-4 flex items-center gap-2">
            <Command className="text-blue-500" size={20} />
            Available Bot Commands
          </h2>
          <div className="space-y-3">
            {botCommands.map((item, index) => (
              <div 
                key={index} 
                className="border border-gray-100 rounded-xl overflow-hidden transition-all duration-200"
              >
                <button
                  onClick={() => toggleAccordion(index)}
                  className="w-full flex items-center justify-between p-4 bg-gray-50 hover:bg-gray-100 transition-colors text-left"
                >
                  <span className="font-medium text-gray-800">{item.command}</span>
                  <ChevronDown 
                    size={20} 
                    className={`text-gray-500 transition-transform duration-300 ${openAccordion === index ? 'rotate-180' : ''}`} 
                  />
                </button>
                <div 
                  className={`overflow-hidden transition-all duration-300 ease-in-out ${
                    openAccordion === index ? 'max-h-40 opacity-100' : 'max-h-0 opacity-0'
                  }`}
                >
                  <div className="p-4 text-gray-600 bg-white border-t border-gray-100">
                    {item.description}
                  </div>
                </div>
              </div>
            ))}
          </div>
        </section>
        </>
        )}
      </div>
    </div>
  );
}
