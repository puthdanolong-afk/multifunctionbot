import express from 'express';
import { createServer as createViteServer } from 'vite';
import path from 'path';
import { Telegraf } from 'telegraf';
import { message } from 'telegraf/filters';
import { GoogleGenAI, Modality } from '@google/genai';
import axios from 'axios';
import youtubedl from 'youtube-dl-exec';
import archiver from 'archiver';
import fs from 'fs';
import { execSync } from 'child_process';
import { PDFDocument } from 'pdf-lib';
import * as pdfjsLib from 'pdfjs-dist/legacy/build/pdf.mjs';
import { createCanvas, CanvasRenderingContext2D } from 'canvas';
import { Path2D, applyPath2DToCanvasRenderingContext } from 'path2d';

// Polyfill Path2D for pdfjs-dist in Node.js
(global as any).Path2D = Path2D;
applyPath2DToCanvasRenderingContext(CanvasRenderingContext2D as any);

import { userManager } from './src/lib/userManager';

class NodeCanvasFactory {
  create(width: number, height: number) {
    if (width <= 0 || height <= 0) {
      throw new Error("Invalid canvas size");
    }
    const canvas = createCanvas(width, height);
    return {
      canvas,
      context: canvas.getContext("2d")
    };
  }
  reset(canvasAndContext: any, width: number, height: number) {
    if (!canvasAndContext.canvas) {
      throw new Error("Canvas is not specified");
    }
    if (width <= 0 || height <= 0) {
      throw new Error("Invalid canvas size");
    }
    canvasAndContext.canvas.width = width;
    canvasAndContext.canvas.height = height;
  }
  destroy(canvasAndContext: any) {
    if (!canvasAndContext.canvas) {
      throw new Error("Canvas is not specified");
    }
    canvasAndContext.canvas.width = 0;
    canvasAndContext.canvas.height = 0;
    canvasAndContext.canvas = null;
    canvasAndContext.context = null;
  }
}

async function startServer() {
  const app = express();
  const PORT = Number(process.env.PORT) || 3000;

  // Write YouTube cookies to file if provided
  const cookiesFile = path.join(process.cwd(), 'youtube_cookies.txt');
  if (process.env.YOUTUBE_COOKIES) {
    try {
      fs.writeFileSync(cookiesFile, process.env.YOUTUBE_COOKIES);
      console.log('YouTube cookies loaded from environment variables.');
    } catch (e) {
      console.error('Failed to write YouTube cookies file:', e);
    }
  } else if (fs.existsSync(cookiesFile)) {
    // Clear old cookies if env var is removed
    try { fs.unlinkSync(cookiesFile); } catch (e) {}
  }

  // Initialize Gemini
  let ai: GoogleGenAI | null = null;
  const geminiKey = process.env.CUSTOM_GEMINI_KEY || process.env.GEMINI_API_KEY;
  try {
    if (geminiKey && geminiKey !== 'MY_GEMINI_API_KEY' && geminiKey !== 'YOUR_GEMINI_API_KEY') {
      ai = new GoogleGenAI({ apiKey: geminiKey });
    }
  } catch (e) {
    console.error('Failed to initialize Gemini:', e);
  }

  // Initialize Telegram Bot
  let bot: Telegraf | null = null;
  const botToken = process.env.TELEGRAM_BOT_TOKEN;

  const pendingLargeVideos = new Map<string, { url: string, filePath?: string, isYoutube: boolean }>();

  function zipBuffer(buffer: Buffer, filename: string): Promise<Buffer> {
    return new Promise((resolve, reject) => {
      const archive = archiver('zip', { zlib: { level: 9 } });
      const chunks: Buffer[] = [];
      archive.on('data', chunk => chunks.push(chunk));
      archive.on('end', () => resolve(Buffer.concat(chunks)));
      archive.on('error', err => reject(err));
      archive.append(buffer, { name: filename });
      archive.finalize();
    });
  }

  function getProgressBar(percent: number, length = 15) {
    const filled = Math.max(0, Math.min(length, Math.round((percent / 100) * length)));
    const empty = length - filled;
    return '█'.repeat(filled) + '░'.repeat(empty);
  }

  async function downloadWithProgress(url: string, ctx: any, chatId: number, messageId: number, prefixText: string = 'Downloading'): Promise<Buffer> {
    const response = await axios.get(url, { 
      responseType: 'stream',
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
      }
    });
    const totalLength = parseInt(response.headers['content-length'] || '0', 10);
    
    return new Promise((resolve, reject) => {
      const chunks: Buffer[] = [];
      let downloaded = 0;
      let lastEditTime = Date.now();

      response.data.on('data', (chunk: Buffer) => {
        downloaded += chunk.length;
        chunks.push(chunk);
        
        const now = Date.now();
        if (now - lastEditTime > 2000 && chatId && messageId) {
          lastEditTime = now;
          let text = '';
          if (totalLength) {
            const percent = Math.round((downloaded / totalLength) * 100);
            const downloadedMB = (downloaded / (1024 * 1024)).toFixed(1);
            const totalMB = (totalLength / (1024 * 1024)).toFixed(1);
            const bar = getProgressBar(percent);
            text = `⏳ *${prefixText}*\n\n${bar} ${percent}%\n📥 \`${downloadedMB}MB\` / \`${totalMB}MB\``;
          } else {
            const downloadedMB = (downloaded / (1024 * 1024)).toFixed(1);
            text = `⏳ *${prefixText}*\n\n📥 Downloaded: \`${downloadedMB}MB\`...`;
          }
          ctx.telegram.editMessageText(chatId, messageId, undefined, text, { parse_mode: 'Markdown' }).catch(() => {});
        }
      });

      response.data.on('end', () => resolve(Buffer.concat(chunks)));
      response.data.on('error', reject);
    });
  }

  async function generateContentWithRetry(aiClient: any, params: any, maxRetries = 3) {
    for (let i = 0; i < maxRetries; i++) {
      try {
        return await aiClient.models.generateContent(params);
      } catch (err: any) {
        const isOverloaded = err.message?.includes('503') || err.message?.includes('UNAVAILABLE') || err.message?.includes('429');
        if (isOverloaded && i < maxRetries - 1) {
          const delay = Math.pow(2, i) * 1000 + Math.random() * 1000;
          console.log(`Gemini API overloaded (attempt ${i + 1}/${maxRetries}), retrying in ${Math.round(delay)}ms...`);
          await new Promise(resolve => setTimeout(resolve, delay));
        } else {
          throw err;
        }
      }
    }
  }

  function escapeHTML(text: string): string {
    if (!text) return '';
    return text
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#039;');
  }

  let botLaunchError: string | null = null;

  if (botToken && botToken !== 'YOUR_TELEGRAM_BOT_TOKEN') {
    try {
      // Set handlerTimeout to Infinity to prevent the 90000ms TimeoutError for long tasks
      bot = new Telegraf(botToken, { handlerTimeout: Infinity });
      // ... (rest of the code)

      // Welcome message
      bot.start(async (ctx) => {
        let isAdminUser = false;
        if (ctx.from) {
          const isNewUser = !userManager.hasUser(ctx.from.id);
          const user = userManager.getUser(ctx.from.id, ctx);
          
          const adminId = process.env.ADMIN_TELEGRAM_ID;
          if (adminId && adminId !== 'YOUR_TELEGRAM_ID') {
            if (ctx.from.id.toString() === adminId) {
              isAdminUser = true;
            }
            if (isNewUser) {
              const name = [user.firstName, user.lastName].filter(Boolean).join(' ');
              const username = user.username ? `@${user.username}` : 'N/A';
              const alertMsg = `🆕 <b>New User Alert</b>\n\nID: <code>${user.id}</code>\nName: ${escapeHTML(name)}\nUsername: ${escapeHTML(username)}`;
              bot?.telegram.sendMessage(adminId, alertMsg, { parse_mode: 'HTML' }).catch(() => {});
            }
          }
        }
        
        let welcomeMessage = `Hello! I am a bot created by <b>Puthdano Bot_Developer</b>.

Here is what I can do for you:
1. 📷 <b>Image Tools</b>: Send me an image to extract text (OCR) or convert it to a PDF.
2. 📄 <b>PDF Tools</b>: Send me a PDF document to extract text or convert its pages to images.
3. 🗣️ <b>Text to Speech</b>: Use the <code>/tts &lt;text&gt;</code> command to convert text into an audio message.
4. 🎙️ <b>Voice/Audio to Text</b>: Send me a voice message or audio file and I'll transcribe it for you (supports English and Khmer).
5. 📥 <b>Video Downloader</b>: Send me a link from TikTok, Instagram, Facebook, Threads, or YouTube, and I'll download the video for you. If the video is too large, I can compress it into a zip file.

<b>Available Commands:</b>
/start - Show this welcome message
/setpic - Set your profile picture
/tts &lt;text&gt; - Convert text to speech
/stats - View your usage statistics`;

        if (isAdminUser) {
          welcomeMessage += `\n\n<b>Admin Commands:</b>
/admin_users - List all users
/admin_stats - View global stats
/broadcast &lt;msg&gt; - Send message to all users
/admin_user &lt;id&gt; - View specific user details`;
        }

        welcomeMessage += `\n\nFeel free to send me any of the above to get started!`;
        
        await ctx.reply(welcomeMessage, { parse_mode: 'HTML' }).catch(console.error);
      });

      bot.command('help', async (ctx) => {
        const helpMessage = `🤖 <b>Bot Help & Commands</b>

Here is a quick overview of what I can do:
1. 📷 <b>Image Tools</b>: Send me an image to extract text (OCR) or convert it to a PDF.
2. 📄 <b>PDF Tools</b>: Send me a PDF document to extract text or convert its pages to images.
3. 🗣️ <b>Text to Speech</b>: Use <code>/tts &lt;text&gt;</code> to convert text to speech. You can also reply to a message with <code>/tts</code>, or choose a voice: <code>/tts puck &lt;text&gt;</code>.
4. 🎙️ <b>Voice/Audio to Text</b>: Send me a voice message or audio file and I'll transcribe it for you (supports English and Khmer).
5. 📥 <b>Video Downloader</b>: Send me a link from TikTok, Instagram, Facebook, Threads, or YouTube, and I'll download the video for you. If the video is too large, I can compress it into a zip file.

<b>Available Commands:</b>
/start - Show welcome message
/help - Show this help message
/setpic - Set your profile picture
/tts &lt;text&gt; - Convert text to speech
/stats - View your usage statistics`;

        await ctx.reply(helpMessage, { parse_mode: 'HTML' }).catch(console.error);
      });

    const pendingProfilePics = new Set<number>();
    const pendingFiles = new Map<string, { fileId?: string, fileIds?: string[], type: 'photo' | 'pdf' | 'photo_group' }>();
    const mediaGroups = new Map<string, { fileIds: string[], timer: NodeJS.Timeout }>();
    const pendingVideoRetries = new Map<string, string>();

    bot.on('my_chat_member', async (ctx) => {
      if (ctx.chat.type === 'private') {
        const status = ctx.myChatMember.new_chat_member.status;
        if (status === 'kicked' || status === 'left') {
          userManager.setUserStatus(ctx.chat.id, false);
        } else if (status === 'member') {
          userManager.setUserStatus(ctx.chat.id, true);
        }
      }
    });

    bot.command('setpic', async (ctx) => {
      if (!ctx.from) return;
      pendingProfilePics.add(ctx.from.id);
      await ctx.reply('🖼️ Please send me the photo you want to use as your profile picture.').catch(console.error);
    });

    // 1. Extract text from image and PDF
    bot.on(message('photo'), async (ctx) => {
      if (ctx.from) {
        userManager.getUser(ctx.from.id, ctx);
        
        if (pendingProfilePics.has(ctx.from.id)) {
          const photo = ctx.message.photo.pop();
          if (photo) {
            userManager.setProfilePic(ctx.from.id, photo.file_id);
            pendingProfilePics.delete(ctx.from.id);
            return ctx.reply('✅ Profile picture updated successfully! You can view it using /stats.');
          }
        }
      }
      
      const photo = ctx.message.photo.pop();
      if (!photo) return;

      const msg = ctx.message as any;
      if (msg.media_group_id) {
        const groupId = msg.media_group_id;
        if (!mediaGroups.has(groupId)) {
          mediaGroups.set(groupId, {
            fileIds: [],
            timer: setTimeout(() => {}, 0) // dummy timer
          });
        }
        
        const group = mediaGroups.get(groupId)!;
        group.fileIds.push(photo.file_id);
        
        clearTimeout(group.timer);
        group.timer = setTimeout(async () => {
          const finalGroup = mediaGroups.get(groupId);
          if (!finalGroup) return;
          mediaGroups.delete(groupId);
          
          const shortId = Math.random().toString(36).substring(2, 10);
          pendingFiles.set(shortId, { fileIds: finalGroup.fileIds, type: 'photo_group' });

          await ctx.reply(`Received ${finalGroup.fileIds.length} images. What would you like to do?`, {
            reply_markup: {
              inline_keyboard: [
                [{ text: '📝 Extract Text (OCR)', callback_data: `ocr_group_${shortId}` }],
                [{ text: '📄 Convert to single PDF', callback_data: `pdf_group_${shortId}` }]
              ]
            }
          });
        }, 2000);
        
        return;
      }
      
      const shortId = Math.random().toString(36).substring(2, 10);
      pendingFiles.set(shortId, { fileId: photo.file_id, type: 'photo' });

      await ctx.reply('What would you like to do with this image?', {
        reply_markup: {
          inline_keyboard: [
            [{ text: '📝 Extract Text (OCR)', callback_data: `ocr_photo_${shortId}` }],
            [{ text: '📄 Convert to PDF', callback_data: `pdf_photo_${shortId}` }]
          ]
        }
      });
    });

    bot.on(message('document'), async (ctx) => {
      if (ctx.from) {
        userManager.getUser(ctx.from.id, ctx);
      }
      const doc = ctx.message.document;
      if (doc.mime_type === 'application/pdf') {
        const shortId = Math.random().toString(36).substring(2, 10);
        pendingFiles.set(shortId, { fileId: doc.file_id, type: 'pdf' });

        await ctx.reply('What would you like to do with this PDF?', {
          reply_markup: {
            inline_keyboard: [
              [{ text: '📝 Extract Text', callback_data: `ocr_pdf_${shortId}` }],
              [{ text: '🖼️ Convert to Images', callback_data: `img_pdf_${shortId}` }]
            ]
          }
        });
      } else if (doc.mime_type && doc.mime_type.startsWith('image/')) {
        const shortId = Math.random().toString(36).substring(2, 10);
        pendingFiles.set(shortId, { fileId: doc.file_id, type: 'photo' });

        await ctx.reply('What would you like to do with this image?', {
          reply_markup: {
            inline_keyboard: [
              [{ text: '📝 Extract Text (OCR)', callback_data: `ocr_photo_${shortId}` }],
              [{ text: '📄 Convert to PDF', callback_data: `pdf_photo_${shortId}` }]
            ]
          }
        });
      }
    });

    // Handle inline keyboard callbacks for files
    bot.action(/^(ocr_photo|pdf_photo|ocr_pdf|img_pdf)_(.+)$/, async (ctx) => {
      const action = ctx.match[1];
      const shortId = ctx.match[2];
      const fileData = pendingFiles.get(shortId);

      if (!fileData) {
        return ctx.answerCbQuery('File expired or not found. Please send it again.');
      }

      await ctx.answerCbQuery();
      await ctx.editMessageReplyMarkup(undefined); // Remove buttons

      try {
        const statusMsg = await ctx.reply('⏳ *Step 1/2:* Downloading file...', { parse_mode: 'Markdown' });
        const fileLink = await ctx.telegram.getFileLink(fileData.fileId);
        const response = await axios.get(fileLink.href, { responseType: 'arraybuffer' });
        const buffer = Buffer.from(response.data, 'binary');

        if (action === 'ocr_photo' || action === 'ocr_pdf') {
          if (!ai) {
            await ctx.telegram.deleteMessage(ctx.chat.id, statusMsg.message_id).catch(() => {});
            return ctx.reply('❌ Gemini AI is not configured. Please set the GEMINI_API_KEY environment variable in the Secrets panel to use AI features.');
          }
          if (ctx.from) {
            userManager.incrementStat(ctx.from.id, action === 'ocr_photo' ? 'imagesProcessed' : 'pdfsProcessed');
          }
          
          const mimeType = action === 'ocr_photo' ? 'image/jpeg' : 'application/pdf';
          const base64Data = buffer.toString('base64');

          try {
            await ctx.telegram.editMessageText(ctx.chat.id, statusMsg.message_id, undefined, '🧠 *Step 2/2:* Extracting text using AI... (This may take a few seconds)', { parse_mode: 'Markdown' }).catch(() => {});
            
            const ocrPrompt = `You are an expert document parser and OCR system. Extract all text from this document accurately. 
- Maintain the original structure, including headings, paragraphs, and lists. 
- If you encounter tables, format them meticulously as Markdown tables. 
- Preserve logical reading order even in multi-column layouts or complex densities. 
- Accurately transcribe any handwritten text, math formulas, or code snippets. 
- Support multiple languages seamlessly (especially Khmer, English, and mixed languages). 
- If the image is a photo with glare, blur, or skewed angles, do your best to infer and extract the obscured text based on context. 
- If a page contains only images, describe the images briefly.
- Output ONLY the extracted text, without any conversational filler.`;

            const aiResponse = await generateContentWithRetry(ai, {
              model: 'gemini-2.5-flash',
              contents: [
                { inlineData: { data: base64Data, mimeType } },
                ocrPrompt
              ]
            });
            await ctx.telegram.deleteMessage(ctx.chat.id, statusMsg.message_id).catch(() => {});
            await ctx.reply(aiResponse.text || 'No text found.');
          } catch (aiErr: any) {
            console.error('Gemini AI OCR error details:', {
              message: aiErr.message,
              stack: aiErr.stack,
              status: aiErr.status,
              details: aiErr.details
            });
            if (aiErr.message?.includes('429') || aiErr.message?.includes('Quota exceeded')) {
              await ctx.telegram.editMessageText(ctx.chat.id, statusMsg.message_id, undefined, '❌ The AI model quota has been exceeded. Please try again later.').catch(() => {});
            } else if (aiErr.message?.includes('503') || aiErr.message?.includes('UNAVAILABLE')) {
              await ctx.telegram.editMessageText(ctx.chat.id, statusMsg.message_id, undefined, '❌ The AI model is currently experiencing high demand. Please try again in a few minutes.').catch(() => {});
            } else {
              await ctx.telegram.editMessageText(ctx.chat.id, statusMsg.message_id, undefined, '❌ Sorry, an error occurred while processing the image/PDF with AI. Please try again later.').catch(() => {});
            }
          }
        } 
        else if (action === 'pdf_photo') {
          if (ctx.from) userManager.incrementStat(ctx.from.id, 'imagesProcessed');
          await ctx.telegram.editMessageText(ctx.chat.id, statusMsg.message_id, undefined, '🔄 *Step 2/2:* Converting image to PDF...', { parse_mode: 'Markdown' }).catch(() => {});
          
          const pdfDoc = await PDFDocument.create();
          let image;
          try {
            image = await pdfDoc.embedJpg(buffer);
          } catch (e) {
            image = await pdfDoc.embedPng(buffer);
          }
          
          const page = pdfDoc.addPage([image.width, image.height]);
          page.drawImage(image, { x: 0, y: 0, width: image.width, height: image.height });
          
          const pdfBytes = await pdfDoc.save();
          await ctx.telegram.deleteMessage(ctx.chat.id, statusMsg.message_id).catch(() => {});
          await ctx.replyWithDocument({ source: Buffer.from(pdfBytes), filename: 'converted.pdf' });
        }
        else if (action === 'img_pdf') {
          if (ctx.from) userManager.incrementStat(ctx.from.id, 'pdfsProcessed');
          await ctx.telegram.editMessageText(ctx.chat.id, statusMsg.message_id, undefined, '🔄 *Step 2/2:* Converting PDF pages to images...', { parse_mode: 'Markdown' }).catch(() => {});
          
          const data = new Uint8Array(buffer);
          const loadingTask = pdfjsLib.getDocument({ 
            data,
            standardFontDataUrl: path.join(process.cwd(), 'node_modules/pdfjs-dist/standard_fonts/'),
            cMapUrl: path.join(process.cwd(), 'node_modules/pdfjs-dist/cmaps/'),
            cMapPacked: true,
            wasmUrl: path.join(process.cwd(), 'node_modules/pdfjs-dist/wasm/'),
            disableFontFace: true,
            CanvasFactory: NodeCanvasFactory as any
          });
          const pdfDocument = await loadingTask.promise;
          
          const numPages = Math.min(pdfDocument.numPages, 50);
          let mediaGroup: any[] = [];
          
          for (let i = 1; i <= numPages; i++) {
            if (i % 5 === 0 || i === 1) {
              await ctx.telegram.editMessageText(ctx.chat.id, statusMsg.message_id, undefined, `🔄 *Step 2/2:* Converting PDF pages to images... (${i}/${numPages})`, { parse_mode: 'Markdown' }).catch(() => {});
            }
            const page = await pdfDocument.getPage(i);
            const viewport = page.getViewport({ scale: 3.0 }); // Increased scale for better quality
            
            const canvas = createCanvas(viewport.width, viewport.height);
            const context = canvas.getContext('2d');
            
            // Fill with white background to prevent transparent/black issues
            context.fillStyle = 'white';
            context.fillRect(0, 0, canvas.width, canvas.height);
            
            await page.render({ canvasContext: context as any, viewport, canvasFactory: new NodeCanvasFactory() } as any).promise;
            const imgBuffer = canvas.toBuffer('image/jpeg', { quality: 1.0 }); // Max quality
            
            page.cleanup(); // Free memory
            
            mediaGroup.push({
              type: 'photo',
              media: { source: imgBuffer },
              caption: `Page ${i}`
            });

            if (mediaGroup.length === 10 || i === numPages) {
              await ctx.replyWithMediaGroup(mediaGroup);
              mediaGroup = [];
            }
          }
          await ctx.telegram.deleteMessage(ctx.chat.id, statusMsg.message_id).catch(() => {});
          await ctx.reply(`✅ Conversion complete! (${numPages} pages)`);
        }
        
        pendingFiles.delete(shortId);
      } catch (e: any) {
        console.error('Error processing file action:', e);
        if (e.message?.includes('API key not valid')) {
          await ctx.reply('❌ Gemini API key is invalid. Please update it in the AI Studio Secrets panel.');
        } else {
          await ctx.reply('❌ Error processing your request.');
        }
      }
    });

    bot.action(/ocr_group_(.+)/, async (ctx) => {
      const shortId = ctx.match[1];
      const fileData = pendingFiles.get(shortId);

      if (!fileData || !fileData.fileIds) {
        return ctx.answerCbQuery('Session expired or invalid file.', { show_alert: true });
      }

      if (!ai) {
        return ctx.answerCbQuery('❌ Gemini AI is not configured.', { show_alert: true });
      }

      await ctx.answerCbQuery();
      await ctx.editMessageReplyMarkup(undefined); // Remove buttons

      try {
        const statusMsg = await ctx.reply(`⏳ *Step 1/2:* Downloading ${fileData.fileIds.length} images...`, { parse_mode: 'Markdown' });
        
        const contents: any[] = [];
        
        for (let i = 0; i < fileData.fileIds.length; i++) {
          const fileId = fileData.fileIds[i];
          const fileLink = await ctx.telegram.getFileLink(fileId);
          const response = await axios.get(fileLink.href, { responseType: 'arraybuffer' });
          const buffer = Buffer.from(response.data, 'binary');
          const base64Data = buffer.toString('base64');
          contents.push({ inlineData: { data: base64Data, mimeType: 'image/jpeg' } });
        }
        
        await ctx.telegram.editMessageText(ctx.chat.id, statusMsg.message_id, undefined, '🧠 *Step 2/2:* Extracting text from all images using AI... (This may take a moment)', { parse_mode: 'Markdown' }).catch(() => {});
        
        const ocrPrompt = `You are an expert document parser and OCR system. Extract all text from these ${fileData.fileIds.length} images accurately. 
- Maintain the original structure, including headings, paragraphs, and lists. 
- If you encounter tables, format them meticulously as Markdown tables. 
- Preserve logical reading order even in multi-column layouts or complex densities. 
- Accurately transcribe any handwritten text, math formulas, or code snippets. 
- Support multiple languages seamlessly (especially Khmer, English, and mixed languages). 
- If the image is a photo with glare, blur, or skewed angles, do your best to infer and extract the obscured text based on context. 
- If a page contains only images, describe the images briefly.
- Output ONLY the extracted text, without any conversational filler. Separate the text from each image clearly if needed.`;

        contents.push(ocrPrompt);

        const aiResponse = await generateContentWithRetry(ai, {
          model: 'gemini-2.5-flash',
          contents: contents
        });
        
        await ctx.telegram.deleteMessage(ctx.chat.id, statusMsg.message_id).catch(() => {});
        await ctx.reply(aiResponse.text || 'No text found.');
        
        if (ctx.from) userManager.incrementStat(ctx.from.id, 'imagesProcessed');
        pendingFiles.delete(shortId);
      } catch (e: any) {
        console.error('Error processing group OCR:', e);
        if (e.message?.includes('429') || e.message?.includes('Quota exceeded')) {
          await ctx.reply('❌ The AI model quota has been exceeded. Please try again later.');
        } else if (e.message?.includes('503') || e.message?.includes('UNAVAILABLE')) {
          await ctx.reply('❌ The AI model is currently experiencing high demand. Please try again in a few minutes.');
        } else {
          await ctx.reply('❌ Error processing your request.');
        }
      }
    });

    bot.action(/pdf_group_(.+)/, async (ctx) => {
      const shortId = ctx.match[1];
      const fileData = pendingFiles.get(shortId);

      if (!fileData || !fileData.fileIds) {
        return ctx.answerCbQuery('Session expired or invalid file.', { show_alert: true });
      }

      await ctx.answerCbQuery();
      await ctx.editMessageReplyMarkup(undefined); // Remove buttons

      try {
        const statusMsg = await ctx.reply(`⏳ *Step 1/2:* Downloading ${fileData.fileIds.length} images...`, { parse_mode: 'Markdown' });
        
        const pdfDoc = await PDFDocument.create();
        
        for (let i = 0; i < fileData.fileIds.length; i++) {
          const fileId = fileData.fileIds[i];
          const fileLink = await ctx.telegram.getFileLink(fileId);
          const response = await axios.get(fileLink.href, { responseType: 'arraybuffer' });
          const buffer = Buffer.from(response.data, 'binary');
          
          let image;
          try {
            image = await pdfDoc.embedJpg(buffer);
          } catch (e) {
            image = await pdfDoc.embedPng(buffer);
          }
          
          const page = pdfDoc.addPage([image.width, image.height]);
          page.drawImage(image, { x: 0, y: 0, width: image.width, height: image.height });
        }
        
        await ctx.telegram.editMessageText(ctx.chat.id, statusMsg.message_id, undefined, '🔄 *Step 2/2:* Generating PDF...', { parse_mode: 'Markdown' }).catch(() => {});
        
        const pdfBytes = await pdfDoc.save();
        await ctx.telegram.deleteMessage(ctx.chat.id, statusMsg.message_id).catch(() => {});
        await ctx.replyWithDocument({ source: Buffer.from(pdfBytes), filename: 'converted_group.pdf' });
        
        if (ctx.from) userManager.incrementStat(ctx.from.id, 'imagesProcessed');
        pendingFiles.delete(shortId);
      } catch (e: any) {
        console.error('Error processing group PDF:', e);
        await ctx.reply('Error processing your request.');
      }
    });

    // 2. Text to voice MP3
    bot.command('tts', async (ctx) => {
      if (ctx.from) {
        userManager.getUser(ctx.from.id, ctx);
      }
      if (!ai) return ctx.reply('❌ Gemini AI is not configured. Please set the GEMINI_API_KEY environment variable in the Secrets panel to use AI features.');
      try {
        let text = ctx.message.text.replace('/tts', '').trim();
        
        // Support replying to a message
        if (!text && ctx.message.reply_to_message && 'text' in ctx.message.reply_to_message) {
          text = ctx.message.reply_to_message.text;
        }

        if (!text) {
          return ctx.reply('Please provide text or reply to a message. \n\nExample: `/tts Hello world`\nYou can also choose a voice: `/tts puck Hello world`\n\nVoices: Puck, Charon, Kore, Fenrir, Aoede', { parse_mode: 'Markdown' });
        }

        // Check for voice selection
        const voices = ['puck', 'charon', 'kore', 'fenrir', 'aoede'];
        let selectedVoice = 'Kore';
        const firstWord = text.split(' ')[0].toLowerCase();
        
        if (voices.includes(firstWord)) {
          selectedVoice = firstWord.charAt(0).toUpperCase() + firstWord.slice(1);
          text = text.substring(firstWord.length).trim();
          if (!text) {
             return ctx.reply('Please provide text after the voice name. Example: `/tts puck Hello world`', { parse_mode: 'Markdown' });
          }
        }

        if (ctx.from) {
          userManager.incrementStat(ctx.from.id, 'audioGenerated');
        }
        const statusMsg = await ctx.reply(`⏳ Generating audio with voice *${selectedVoice}*...`, { parse_mode: 'Markdown' });

        const aiResponse = await generateContentWithRetry(ai, {
          model: "gemini-2.5-flash-preview-tts",
          contents: [{ parts: [{ text: text }] }],
          config: {
            responseModalities: [Modality.AUDIO],
            speechConfig: {
              voiceConfig: {
                prebuiltVoiceConfig: { voiceName: selectedVoice },
              },
            },
          },
        });

        const base64Audio = aiResponse.candidates?.[0]?.content?.parts?.[0]?.inlineData?.data;
        if (base64Audio) {
          const pcmBuffer = Buffer.from(base64Audio, 'base64');
          
          // Gemini TTS returns 24kHz, 1 channel, 16-bit PCM
          const sampleRate = 24000;
          const channels = 1;
          const bitsPerSample = 16;
          
          // Generate WAV header
          const wavHeader = Buffer.alloc(44);
          wavHeader.write('RIFF', 0);
          wavHeader.writeUInt32LE(36 + pcmBuffer.length, 4);
          wavHeader.write('WAVE', 8);
          wavHeader.write('fmt ', 12);
          wavHeader.writeUInt32LE(16, 16); // Subchunk1Size (16 for PCM)
          wavHeader.writeUInt16LE(1, 20); // AudioFormat (1 for PCM)
          wavHeader.writeUInt16LE(channels, 22);
          wavHeader.writeUInt32LE(sampleRate, 24);
          wavHeader.writeUInt32LE(sampleRate * channels * (bitsPerSample / 8), 28); // ByteRate
          wavHeader.writeUInt16LE(channels * (bitsPerSample / 8), 32); // BlockAlign
          wavHeader.writeUInt16LE(bitsPerSample, 34);
          wavHeader.write('data', 36);
          wavHeader.writeUInt32LE(pcmBuffer.length, 40);
          
          const wavBuffer = Buffer.concat([wavHeader, pcmBuffer]);

          await ctx.telegram.deleteMessage(ctx.chat.id, statusMsg.message_id).catch(() => {});
          await ctx.replyWithAudio({ source: wavBuffer, filename: 'voice.wav' });
        } else {
          await ctx.telegram.editMessageText(ctx.chat.id, statusMsg.message_id, undefined, '❌ Failed to generate audio.').catch(() => {});
        }
      } catch (e: any) {
        console.error('Gemini AI TTS error details:', {
          message: e.message,
          stack: e.stack,
          status: e.status,
          details: e.details
        });
        if (e.message?.includes('API key not valid')) {
          await ctx.reply('❌ Gemini API key is invalid. Please update it in the AI Studio Secrets panel.');
        } else if (e.message?.includes('503') || e.message?.includes('UNAVAILABLE')) {
          await ctx.reply('❌ The AI model is currently experiencing high demand. Please try again in a few minutes.');
        } else {
          await ctx.reply('❌ Sorry, an error occurred while generating audio. Please try again later.');
        }
      }
    });

    // 3. MP3 to text (Voice/Audio to text)
    const pendingTranscriptions = new Map<string, { fileId: string, mimeType: string }>();

    const handleAudioMessage = async (ctx: any, fileId: string, mimeType: string) => {
      if (ctx.from) {
        userManager.getUser(ctx.from.id, ctx);
      }
      if (!ai) return ctx.reply('❌ Gemini AI is not configured. Please set the GEMINI_API_KEY environment variable in the Secrets panel to use AI features.');
      const shortId = Math.random().toString(36).substring(2, 10);
      pendingTranscriptions.set(shortId, { fileId, mimeType });

      // Get user's preferred language if available
      const user = ctx.from ? userManager.getUser(ctx.from.id) : null;
      const prefLang = user?.language || 'auto';

      await ctx.reply('Please select the language for transcription:', {
        reply_markup: {
          inline_keyboard: [
            [
              { text: `🇰🇭 Khmer${prefLang === 'km' ? ' (Preferred)' : ''}`, callback_data: `transcribe_km_${shortId}` },
              { text: `🇬🇧 English${prefLang === 'en' ? ' (Preferred)' : ''}`, callback_data: `transcribe_en_${shortId}` }
            ],
            [
              { text: `🇫🇷 French${prefLang === 'fr' ? ' (Preferred)' : ''}`, callback_data: `transcribe_fr_${shortId}` },
              { text: `🇪🇸 Spanish${prefLang === 'es' ? ' (Preferred)' : ''}`, callback_data: `transcribe_es_${shortId}` }
            ],
            [
              { text: `🇨🇳 Chinese${prefLang === 'zh' ? ' (Preferred)' : ''}`, callback_data: `transcribe_zh_${shortId}` },
              { text: `🇯🇵 Japanese${prefLang === 'ja' ? ' (Preferred)' : ''}`, callback_data: `transcribe_ja_${shortId}` }
            ],
            [
              { text: `🌐 Auto Detect${prefLang === 'auto' ? ' (Preferred)' : ''}`, callback_data: `transcribe_auto_${shortId}` }
            ]
          ]
        }
      });
    };

    bot.on(message('voice'), async (ctx) => {
      await handleAudioMessage(ctx, ctx.message.voice.file_id, 'audio/ogg');
    });

    bot.on(message('audio'), async (ctx) => {
      await handleAudioMessage(ctx, ctx.message.audio.file_id, ctx.message.audio.mime_type || 'audio/mp3');
    });

    bot.action(/transcribe_([a-z]+)_(.+)/, async (ctx) => {
      if (!ai) return ctx.answerCbQuery('❌ Gemini AI is not configured. Please set GEMINI_API_KEY in Secrets.', { show_alert: true });
      
      const lang = ctx.match[1];
      const shortId = ctx.match[2];
      const audioData = pendingTranscriptions.get(shortId);

      if (!audioData) {
        return ctx.answerCbQuery('Transcription session expired. Please send the audio again.', { show_alert: true });
      }

      if (ctx.from) {
        userManager.setLanguage(ctx.from.id, lang);
        userManager.incrementStat(ctx.from.id, 'audioTranscribed');
      }

      await ctx.answerCbQuery();
      await ctx.editMessageText('⏳ *Step 1/2:* Downloading audio file...', { parse_mode: 'Markdown' }).catch(() => {});

      try {
        const fileLink = await ctx.telegram.getFileLink(audioData.fileId);
        const response = await axios.get(fileLink.href, { responseType: 'arraybuffer' });
        const base64Audio = Buffer.from(response.data, 'binary').toString('base64');

        await ctx.editMessageText('🧠 *Step 2/2:* Transcribing audio using AI... (This may take a few seconds)', { parse_mode: 'Markdown' }).catch(() => {});

        let prompt = `Please provide a highly accurate transcription of the following audio.
- Transcribe exactly what is spoken.
- Preserve natural hesitations and filler words if they are prominent, but ensure the final text is highly readable.
- Apply correct punctuation, capitalization, and grammar.
- Do NOT translate the audio. Transcribe it in its original language.
- Output ONLY the transcription text, without any conversational filler or introductions.`;

        if (lang !== 'auto') {
          const langMap: Record<string, string> = {
            'km': 'Khmer',
            'en': 'English',
            'fr': 'French',
            'es': 'Spanish',
            'zh': 'Chinese',
            'ja': 'Japanese'
          };
          const targetLang = langMap[lang] || lang;
          prompt = `Please provide a highly accurate transcription of the following audio strictly in the ${targetLang} language.
- Transcribe exactly what is spoken.
- Apply correct ${targetLang} spelling, punctuation, capitalization, and grammar.
- Do NOT translate the audio.
- Output ONLY the transcription text, without any conversational filler or introductions.`;
        }

        const aiResponse = await generateContentWithRetry(ai, {
          model: 'gemini-3-flash-preview',
          contents: [
            { inlineData: { data: base64Audio, mimeType: audioData.mimeType } },
            prompt
          ]
        });
        
        const transcription = aiResponse.text?.trim();
        if (transcription) {
          const formattedText = `🎙️ *Transcription:*\n\n${transcription}`;
          await ctx.editMessageText(formattedText, { parse_mode: 'Markdown' }).catch(() => {});
        } else {
          await ctx.editMessageText('❌ Could not transcribe the audio.').catch(() => {});
        }
        pendingTranscriptions.delete(shortId);
      } catch (e: any) {
        console.error('Gemini AI Transcription error details:', {
          message: e.message,
          stack: e.stack,
          status: e.status,
          details: e.details
        });
        if (e.message?.includes('API key not valid')) {
          await ctx.editMessageText('❌ Gemini API key is invalid. Please update it in the AI Studio Secrets panel.').catch(() => {});
        } else if (e.message?.includes('429') || e.message?.includes('Quota exceeded')) {
          await ctx.editMessageText('❌ The AI model quota has been exceeded. Please try again later.').catch(() => {});
        } else if (e.message?.includes('503') || e.message?.includes('UNAVAILABLE')) {
          await ctx.editMessageText('❌ The AI model is currently experiencing high demand. Please try again in a few minutes.').catch(() => {});
        } else {
          await ctx.editMessageText('❌ Sorry, an error occurred while transcribing audio. Please try again later.').catch(() => {});
        }
      }
    });

    // Admin Commands
    const isAdmin = (ctx: any) => {
      const adminId = process.env.ADMIN_TELEGRAM_ID;
      return adminId && adminId !== 'YOUR_TELEGRAM_ID' && ctx.from?.id.toString() === adminId;
    };

    bot.command('admin_users', async (ctx) => {
      if (!isAdmin(ctx)) return;
      const users = userManager.getAllUsers();
      
      if (users.length === 0) {
        return ctx.reply('No users found.');
      }

      let message = `👥 <b>Total Users:</b> ${users.length}\n\n`;
      let currentChunk = message;

      for (const user of users) {
        const name = [user.firstName, user.lastName].filter(Boolean).join(' ');
        const username = user.username ? `@${user.username}` : 'N/A';
        const statusIcon = user.isActive === false ? '🔴' : '🟢';
        const userLine = `${statusIcon} ID: <code>${user.id}</code> | Name: ${escapeHTML(name)} | Username: ${escapeHTML(username)}\n`;
        
        if (currentChunk.length + userLine.length > 4000) {
          await ctx.reply(currentChunk, { parse_mode: 'HTML' });
          currentChunk = userLine;
        } else {
          currentChunk += userLine;
        }
      }

      if (currentChunk.length > 0) {
        await ctx.reply(currentChunk, { parse_mode: 'HTML' });
      }
    });

    bot.command('admin_stats', async (ctx) => {
      if (!isAdmin(ctx)) return;
      const users = userManager.getAllUsers();
      
      let totalImages = 0;
      let totalPdfs = 0;
      let totalAudioGen = 0;
      let totalAudioTrans = 0;
      let totalVideos = 0;

      for (const user of users) {
        totalImages += user.stats.imagesProcessed || 0;
        totalPdfs += user.stats.pdfsProcessed || 0;
        totalAudioGen += user.stats.audioGenerated || 0;
        totalAudioTrans += user.stats.audioTranscribed || 0;
        totalVideos += user.stats.videosDownloaded || 0;
      }

      const activeUsers = users.filter(u => u.isActive !== false).length;
      const leftUsers = users.filter(u => u.isActive === false).length;

      const statsMsg = `📈 *Global Usage Statistics*

👥 Total Users: ${users.length} (🟢 ${activeUsers} Active | 🔴 ${leftUsers} Left)

📷 Total Images Processed: ${totalImages}
📄 Total PDFs Processed: ${totalPdfs}
🗣️ Total Audio Generated: ${totalAudioGen}
🎙️ Total Audio Transcribed: ${totalAudioTrans}
📥 Total Videos Downloaded: ${totalVideos}`;

      await ctx.reply(statsMsg, { parse_mode: 'Markdown' });
    });

    bot.command('broadcast', async (ctx) => {
      if (!isAdmin(ctx)) return;
      const message = ctx.message.text.replace('/broadcast', '').trim();
      if (!message) {
        return ctx.reply('Please provide a message to broadcast.\nExample: `/broadcast Hello everyone!`', { parse_mode: 'Markdown' });
      }
      
      const users = userManager.getAllUsers();
      let success = 0;
      let failed = 0;
      
      const statusMsg = await ctx.reply('Broadcasting message...');
      
      for (const user of users) {
        try {
          await bot?.telegram.sendMessage(user.id, message);
          success++;
        } catch (e) {
          failed++;
        }
      }
      
      await ctx.telegram.editMessageText(ctx.chat.id, statusMsg.message_id, undefined, `✅ *Broadcast complete!*\n\nSuccess: ${success}\nFailed: ${failed}`, { parse_mode: 'Markdown' }).catch(() => {});
    });

    bot.command('admin_user', async (ctx) => {
      if (!isAdmin(ctx)) return;
      const args = ctx.message.text.split(' ');
      if (args.length < 2) {
        return ctx.reply('Usage: `/admin_user <user_id>`', { parse_mode: 'Markdown' });
      }
      
      const userId = parseInt(args[1]);
      if (isNaN(userId)) {
        return ctx.reply('Invalid user ID format.');
      }
      
      const user = userManager.getExistingUser(userId);
      if (!user) {
        return ctx.reply('User not found in the database.');
      }
      
      const name = [user.firstName, user.lastName].filter(Boolean).join(' ');
      const username = user.username ? `@${user.username}` : 'N/A';
      
      const userInfo = `👤 <b>User Profile</b>
ID: <code>${user.id}</code>
Status: ${user.isActive === false ? `🔴 Left (${new Date(user.leftAt || '').toLocaleString()})` : '🟢 Active'}
Name: ${escapeHTML(name) || 'N/A'}
Username: ${escapeHTML(username)}
Language: ${user.language || 'N/A'}
First Seen: ${new Date(user.firstSeen).toLocaleString()}
Last Seen: ${new Date(user.lastSeen).toLocaleString()}

📊 <b>Stats</b>
Images: ${user.stats.imagesProcessed}
PDFs: ${user.stats.pdfsProcessed}
Audio Gen: ${user.stats.audioGenerated}
Audio Trans: ${user.stats.audioTranscribed}
Videos: ${user.stats.videosDownloaded}`;

      if (user.profilePicFileId) {
        await ctx.replyWithPhoto(user.profilePicFileId, { caption: userInfo, parse_mode: 'HTML' });
      } else {
        await ctx.reply(userInfo, { parse_mode: 'HTML' });
      }
    });

    bot.command('stats', async (ctx) => {
      if (!ctx.from) return;
      const user = userManager.getUser(ctx.from.id, ctx);
      
      const statsMsg = `📊 *Your Usage Statistics*

📷 Images Processed: ${user.stats.imagesProcessed}
📄 PDFs Processed: ${user.stats.pdfsProcessed}
🗣️ Audio Generated: ${user.stats.audioGenerated}
🎙️ Audio Transcribed: ${user.stats.audioTranscribed}
📥 Videos Downloaded: ${user.stats.videosDownloaded}

📅 First Seen: ${new Date(user.firstSeen).toLocaleDateString()}
🌐 Preferred Language: ${user.language === 'km' ? 'Khmer' : user.language === 'en' ? 'English' : 'Auto Detect'}

💡 _Tip: Use /setpic to set your profile picture!_`;

      if (user.profilePicFileId) {
        await ctx.replyWithPhoto(user.profilePicFileId, { caption: statsMsg, parse_mode: 'Markdown' });
      } else {
        await ctx.reply(statsMsg, { parse_mode: 'Markdown' });
      }
    });

    // 4. Download video from FB, TikTok, IG, Threads, YouTube
    const processVideoDownload = async (ctx: any, url: string, editMessageId?: number) => {
      let cleanUrl = url;
      const isYoutube = cleanUrl.includes('youtube.com') || cleanUrl.includes('youtu.be');
      
      if (isYoutube) {
        try {
          const parsedUrl = new URL(cleanUrl);
          if (parsedUrl.searchParams.has('list')) {
            parsedUrl.searchParams.delete('list');
            parsedUrl.searchParams.delete('index');
            cleanUrl = parsedUrl.toString();
          }
        } catch (e) {
          // Ignore invalid URL parsing errors
        }
      }

      let statusMsgId = editMessageId;
      
      if (!statusMsgId) {
        const statusMsg = await ctx.reply('⏳ *Step 1/2:* Processing video link, please wait...', { parse_mode: 'Markdown' });
        statusMsgId = statusMsg.message_id;
      } else {
        await ctx.telegram.editMessageText(ctx.chat.id, statusMsgId, undefined, '⏳ *Step 1/2:* Processing video link, please wait...', { parse_mode: 'Markdown' }).catch(() => {});
      }

      try {
        let downloadedFilePath = '';
        let videoUrl = '';
        let sizeMB = 0;

        if (cleanUrl.includes('tiktok.com')) {
          // Use TikWM for TikTok as Cobalt public API now requires JWT
          const tikResponse = await axios.post('https://www.tikwm.com/api/', `url=${cleanUrl}`, {
            headers: {
              'Content-Type': 'application/x-www-form-urlencoded',
              'Accept': 'application/json'
            }
          });
          if (tikResponse.data && tikResponse.data.data && tikResponse.data.data.play) {
            videoUrl = tikResponse.data.data.play;
          }
        } else {
          // Use yt-dlp to download directly for best quality (Facebook, Instagram, YouTube, etc.)
          try {
            const tempFile = `/tmp/${Math.random().toString(36).substring(2, 15)}.mp4`;
            await ctx.telegram.editMessageText(ctx.chat.id, statusMsgId, undefined, '⏳ *Step 1/2:* Downloading original high-quality video (this might take a moment)...', { parse_mode: 'Markdown' }).catch(() => {});
            
            // Add a timeout wrapper to prevent hanging indefinitely
            const ytPromise = new Promise<void>((resolve, reject) => {
              const ytOptions: any = {
                format: 'b',
                output: tempFile,
                mergeOutputFormat: 'mp4',
                postprocessorArgs: 'ffmpeg:-movflags faststart',
                noCheckCertificates: true,
                noWarnings: true,
                noPlaylist: true,
                addHeader: ['referer:youtube.com', 'user-agent:Mozilla/5.0'],
                extractorArgs: 'youtube:player_client=android',
                socketTimeout: 30,
                jsRuntimes: 'node'
              };
              
              const cookiesFile = path.join(process.cwd(), 'youtube_cookies.txt');
              if (fs.existsSync(cookiesFile)) {
                ytOptions.cookies = cookiesFile;
              }
              
              // Add PO Token support for YouTube
              if (isYoutube && process.env.YOUTUBE_PO_TOKEN && process.env.YOUTUBE_VISITOR_DATA) {
                ytOptions.extractorArgs = `youtube:player_client=android,web;po_token=web+${process.env.YOUTUBE_PO_TOKEN};visitor_data=${process.env.YOUTUBE_VISITOR_DATA}`;
              }

              const subprocess = youtubedl.exec(cleanUrl, ytOptions);

              subprocess.catch((err: any) => reject(err));

              let lastEditTime = Date.now();
              
              if (subprocess.stdout) {
                subprocess.stdout.on('data', (data: any) => {
                  const output = data.toString();
                  const match = output.match(/\[download\]\s+([\d\.]+)%/);
                  if (match && match[1]) {
                    const percent = parseFloat(match[1]);
                    const now = Date.now();
                    if (now - lastEditTime > 2000) {
                      lastEditTime = now;
                      const bar = getProgressBar(percent);
                      const text = `⏳ *Step 1/2:* Downloading original high-quality video...\n\n${bar} ${Math.round(percent)}%`;
                      ctx.telegram.editMessageText(ctx.chat.id, statusMsgId, undefined, text, { parse_mode: 'Markdown' }).catch(() => {});
                    }
                  }
                });
              }

              let stderrOutput = '';
              if (subprocess.stderr) {
                subprocess.stderr.on('data', (data: any) => {
                  stderrOutput += data.toString();
                });
              }

              subprocess.on('close', (code: number) => {
                if (code === 0) resolve();
                else {
                  const err = new Error(`yt-dlp exited with code ${code}`);
                  (err as any).stderr = stderrOutput;
                  reject(err);
                }
              });
              
              subprocess.on('error', (err: any) => reject(err));
            });
            
            const timeoutPromise = new Promise((_, reject) => setTimeout(() => reject(new Error('yt-dlp timeout')), 60000));
            await Promise.race([ytPromise, timeoutPromise]);

            if (fs.existsSync(tempFile)) {
              downloadedFilePath = tempFile;
              sizeMB = fs.statSync(tempFile).size / (1024 * 1024);
            }
          } catch (ytErr: any) {
            console.error('yt-dlp Error details:', ytErr);
            const combinedError = (ytErr.message || '') + ' ' + (ytErr.stderr || '');
            const isBotDetection = combinedError.includes('Sign in to confirm you’re not a bot') || 
                                   combinedError.includes('Sign in to confirm you');
            
            if (isBotDetection && isYoutube) {
               console.log('yt-dlp bot detection triggered on YouTube, returning custom error to user immediately');
               let userFeedback = '🤖 *Youtube Bot Detection Triggered*\n\n';
               userFeedback += 'YouTube is currently restricting server downloads for this video.\n';
               userFeedback += 'Please add a valid `youtube_cookies.txt` file or update `YOUTUBE_PO_TOKEN / YOUTUBE_VISITOR_DATA` environments to continue.\n';
               const shortId = Math.random().toString(36).substring(2, 10);
               pendingVideoRetries.set(shortId, url);
               return await ctx.telegram.editMessageText(ctx.chat.id, statusMsgId, undefined, userFeedback, { 
                   parse_mode: 'Markdown',
                   reply_markup: { inline_keyboard: [[{ text: '🔄 Retry Download', callback_data: `retry_video_${shortId}` }]] }
               }).catch(() => {});
            } else if (isBotDetection) {
               console.log('yt-dlp bot detection triggered, falling back to Cobalt API');
            } else if (ytErr.message === 'yt-dlp timeout') {
               // yt-dlp timed out, falling back to Cobalt API
            } else {
               // yt-dlp failed, falling back to Cobalt API
            }
            // Fallback to Cobalt API if yt-dlp fails
          }
        }

        // Fallback to Cobalt API for others if yt-dlp failed
        if (!videoUrl && !downloadedFilePath) {
          const headers: Record<string, string> = {
            'Accept': 'application/json',
            'Content-Type': 'application/json',
            'User-Agent': 'Mozilla/5.0'
          };
          
          if (process.env.COBALT_API_KEY) {
            headers['Authorization'] = `Api-Key ${process.env.COBALT_API_KEY}`;
          }

          const cobaltApiUrl = process.env.COBALT_API_URL || 'https://api.cobalt.tools/';
          const response = await axios.post(cobaltApiUrl, {
            url: cleanUrl,
          }, {
            headers: headers,
            validateStatus: () => true // Prevent Axios from throwing on 400+ errors
          });

          if (response.data && response.data.url) {
            videoUrl = response.data.url;
          } else if (response.data && response.data.error) {
            console.error('Cobalt API Error details:', {
              error: response.data.error,
              status: response.status,
              statusText: response.statusText,
              headers: response.headers
            });
            
            const errorCode = response.data.error.code || '';
            let userFeedback = '❌ *Error downloading video.*\n\n';
            
            if (errorCode === 'error.api.auth.jwt.missing' || errorCode === 'error.api.auth.key.missing') {
              userFeedback += '🔑 *Reason:* The download service requires authentication.\n';
              if (isYoutube) {
                if (process.env.YOUTUBE_PO_TOKEN) {
                  userFeedback += '💡 *Suggestion:* The provided PO Token might be expired, or the video is age-restricted/private. Try generating a new PO Token or providing YouTube cookies.';
                } else {
                  userFeedback += '💡 *Suggestion:* YouTube downloads are currently blocked by bot detection. To fix this, please add `YOUTUBE_PO_TOKEN` and `YOUTUBE_VISITOR_DATA` environment variables in the Secrets panel.';
                }
              } else {
                userFeedback += '💡 *Suggestion:* Please configure `COBALT_API_KEY` in the Secrets panel.';
              }
            } else if (errorCode.includes('login') || errorCode.includes('private') || errorCode.includes('members_only')) {
              userFeedback += '🔒 *Reason:* This video is private, restricted, or requires an account to view.\n';
              if (isYoutube) {
                if (process.env.YOUTUBE_PO_TOKEN) {
                  userFeedback += '💡 *Suggestion:* The provided PO Token might be expired, or the video is age-restricted/private. Try generating a new PO Token or providing YouTube cookies.';
                } else {
                  userFeedback += '💡 *Suggestion:* YouTube is blocking the bot. Cookies are no longer enough. You must provide `YOUTUBE_PO_TOKEN` and `YOUTUBE_VISITOR_DATA` environment variables in the Secrets panel.';
                }
              } else {
                userFeedback += '💡 *Suggestion:* Make sure the video is publicly accessible. The bot cannot access private accounts or private groups.';
              }
            } else if (errorCode.includes('geo') || errorCode.includes('country') || errorCode.includes('region')) {
              userFeedback += '🌍 *Reason:* This video is geo-restricted and not available in the bot\'s region.\n';
              userFeedback += '💡 *Suggestion:* Unfortunately, region-locked videos cannot be downloaded by this bot.';
            } else if (errorCode.includes('unsupported') || errorCode.includes('not_found')) {
              userFeedback += '🔗 *Reason:* The link format is not supported or the video could not be found.\n';
              userFeedback += '💡 *Suggestion:* Please check if the link is correct. Supported platforms include YouTube, Facebook, Instagram, TikTok, and Threads.';
            } else if (errorCode.includes('rate_limit') || response.status === 429) {
              userFeedback += '⏳ *Reason:* The download service is currently rate-limited due to high traffic.\n';
              if (isYoutube) {
                userFeedback += '💡 *Suggestion:* YouTube downloads are heavily rate-limited on this server. To bypass this, please add `YOUTUBE_PO_TOKEN` and `YOUTUBE_VISITOR_DATA` environment variables in the Secrets panel.';
              } else {
                userFeedback += '💡 *Suggestion:* Please try again in a few minutes.';
              }
            } else {
              userFeedback += `⚠️ *Reason:* Download service error (${errorCode || 'Unknown error'}).\n`;
              userFeedback += '💡 *Suggestion:* The service might be temporarily down, or the video format is unusual. Please try again later or try a different link.';
            }
            
            const shortId = Math.random().toString(36).substring(2, 10);
            pendingVideoRetries.set(shortId, url);
            return await ctx.telegram.editMessageText(ctx.chat.id, statusMsgId, undefined, userFeedback, { 
              parse_mode: 'Markdown',
              reply_markup: {
                inline_keyboard: [[{ text: '🔄 Retry Download', callback_data: `retry_video_${shortId}` }]]
              }
            }).catch(() => {});
          } else {
            const isHtml = typeof response.data === 'string' && response.data.toLowerCase().includes('<html');
            console.error('Cobalt API Unexpected Response:', {
              data: isHtml ? '[HTML Response Omitted]' : response.data,
              status: response.status,
              statusText: response.statusText
            });
            
            let userFeedback = '❌ *Error downloading video.*\n\n';
            if (response.status >= 500) {
              userFeedback += '⚠️ *Reason:* The download service is currently offline or experiencing issues.\n';
              userFeedback += '💡 *Suggestion:* Please try again later.';
            } else if (response.status === 429) {
              userFeedback += '⏳ *Reason:* The download service is currently rate-limited due to high traffic.\n';
              if (isYoutube) {
                userFeedback += '💡 *Suggestion:* YouTube downloads are heavily rate-limited on this server. To bypass this, please add `YOUTUBE_PO_TOKEN` and `YOUTUBE_VISITOR_DATA` environment variables in the Secrets panel.';
              } else {
                userFeedback += '💡 *Suggestion:* Please try again in a few minutes.';
              }
            } else {
              userFeedback += `⚠️ *Reason:* Unexpected response from download service (HTTP ${response.status}).\n`;
              userFeedback += '💡 *Suggestion:* Please try again later or try a different link.';
            }
            const shortId = Math.random().toString(36).substring(2, 10);
            pendingVideoRetries.set(shortId, url);
            return await ctx.telegram.editMessageText(ctx.chat.id, statusMsgId, undefined, userFeedback, { 
              parse_mode: 'Markdown',
              reply_markup: {
                inline_keyboard: [[{ text: '🔄 Retry Download', callback_data: `retry_video_${shortId}` }]]
              }
            }).catch(() => {});
          }
        }

        if (videoUrl || downloadedFilePath) {
          if (sizeMB === 0 && videoUrl) {
            try {
              const headRes = await axios.head(videoUrl);
              const cl = headRes.headers['content-length'];
              if (cl) sizeMB = parseInt(cl, 10) / (1024 * 1024);
            } catch (e) {
              // ignore
            }
          }

          if (sizeMB > 49) {
            const shortId = Math.random().toString(36).substring(2, 10);
            pendingLargeVideos.set(shortId, { url: videoUrl, filePath: downloadedFilePath, isYoutube });
            
            // Cleanup file after 1 hour if not zipped
            if (downloadedFilePath) {
              setTimeout(() => {
                if (fs.existsSync(downloadedFilePath)) {
                  fs.unlinkSync(downloadedFilePath);
                  pendingLargeVideos.delete(shortId);
                }
              }, 60 * 60 * 1000);
            }

            await ctx.telegram.editMessageText(ctx.chat.id, statusMsgId, undefined, `The video is too large (${sizeMB.toFixed(1)} MB) for Telegram's 50MB bot limit.\nWould you like to receive it as a compressed zip file?`, {
              reply_markup: {
                inline_keyboard: [
                  [
                    { text: '📦 Send as Compressed Zip', callback_data: `zip_video_${shortId}` }
                  ]
                ]
              }
            }).catch(() => {});
          } else {
            if (downloadedFilePath) {
              await ctx.telegram.editMessageText(ctx.chat.id, statusMsgId, undefined, '📤 *Step 2/2:* Uploading video to Telegram...', { parse_mode: 'Markdown' }).catch(() => {});
              
              let extraOptions: any = {};
              try {
                const ffprobeOutput = execSync(`ffprobe -v error -select_streams v:0 -show_entries stream=width,height -of default=nw=1:nk=1 "${downloadedFilePath}"`).toString().trim().split('\n');
                if (ffprobeOutput.length >= 2) {
                  const w = parseInt(ffprobeOutput[0]);
                  const h = parseInt(ffprobeOutput[1]);
                  if (!isNaN(w) && !isNaN(h)) {
                    extraOptions = { width: w, height: h };
                  }
                }
              } catch (e) {
                console.warn('Could not extract video dimensions:', e);
              }
              
              await ctx.replyWithVideo({ source: downloadedFilePath }, extraOptions);
              fs.unlinkSync(downloadedFilePath);
            } else {
              const buffer = await downloadWithProgress(videoUrl, ctx, ctx.chat.id, statusMsgId, '📥 Downloading');
              await ctx.telegram.editMessageText(ctx.chat.id, statusMsgId, undefined, '📤 *Step 2/2:* Uploading video to Telegram...', { parse_mode: 'Markdown' }).catch(() => {});
              await ctx.replyWithVideo({ source: buffer });
            }
            await ctx.telegram.deleteMessage(ctx.chat.id, statusMsgId).catch(() => {});
          }
        } else {
          const shortId = Math.random().toString(36).substring(2, 10);
          pendingVideoRetries.set(shortId, url);
          await ctx.telegram.editMessageText(ctx.chat.id, statusMsgId, undefined, 'Could not download video from this link.', {
            reply_markup: {
              inline_keyboard: [[{ text: '🔄 Retry Download', callback_data: `retry_video_${shortId}` }]]
            }
          }).catch(() => {});
        }
      } catch (e: any) {
        console.error('Error downloading video:', e.response?.data || e.message || e);
        
        let userFeedback = '❌ *Error downloading video.*\n\n';
        const errorString = String(e.message || e).toLowerCase();
        const stderrString = String(e.stderr || '').toLowerCase();
        const combinedError = errorString + ' ' + stderrString;

        if (combinedError.includes('private') || combinedError.includes('login') || combinedError.includes('sign in') || combinedError.includes('members only')) {
          userFeedback += '🔒 *Reason:* This video is private, restricted, or requires an account to view.\n';
          if (isYoutube) {
            if (process.env.YOUTUBE_PO_TOKEN) {
              userFeedback += '💡 *Suggestion:* The provided PO Token might be expired, or the video is age-restricted/private. Try generating a new PO Token or providing YouTube cookies.';
            } else {
              userFeedback += '💡 *Suggestion:* YouTube is blocking the bot. Cookies are no longer enough. You must provide `YOUTUBE_PO_TOKEN` and `YOUTUBE_VISITOR_DATA` environment variables in the Secrets panel.';
            }
          } else {
            userFeedback += '💡 *Suggestion:* Make sure the video is publicly accessible. The bot cannot access private accounts or private groups.';
          }
        } else if (combinedError.includes('country') || combinedError.includes('geo') || combinedError.includes('region')) {
          userFeedback += '🌍 *Reason:* This video is geo-restricted and not available in the bot\'s region.\n';
          userFeedback += '💡 *Suggestion:* Unfortunately, region-locked videos cannot be downloaded by this bot.';
        } else if (combinedError.includes('unsupported url') || combinedError.includes('not known')) {
          userFeedback += '🔗 *Reason:* The link format is not supported or the platform is not recognized.\n';
          userFeedback += '💡 *Suggestion:* Please check if the link is correct. Supported platforms include YouTube, Facebook, Instagram, TikTok, and Threads.';
        } else if (combinedError.includes('404') || combinedError.includes('not found') || combinedError.includes('unavailable')) {
          userFeedback += '🗑️ *Reason:* The video could not be found. It might have been deleted or the link is broken.\n';
          userFeedback += '💡 *Suggestion:* Verify that the link still works in your browser.';
        } else if (combinedError.includes('429') || combinedError.includes('rate limit') || combinedError.includes('too many requests')) {
          userFeedback += '⏳ *Reason:* The download service is currently rate-limited due to high traffic.\n';
          userFeedback += '💡 *Suggestion:* Please try again in a few minutes.';
        } else {
          userFeedback += '⚠️ *Reason:* An unknown error occurred with the download service.\n';
          userFeedback += '💡 *Suggestion:* The service might be temporarily down, or the video format is unusual. Please try again later or try a different link.';
        }

        const shortId = Math.random().toString(36).substring(2, 10);
        pendingVideoRetries.set(shortId, url);
        await ctx.telegram.editMessageText(ctx.chat.id, statusMsgId, undefined, userFeedback, { 
          parse_mode: 'Markdown',
          reply_markup: {
            inline_keyboard: [[{ text: '🔄 Retry Download', callback_data: `retry_video_${shortId}` }]]
          }
        }).catch(() => {});
      }
    };

    bot.on(message('text'), async (ctx, next) => {
      if (ctx.from) {
        userManager.getUser(ctx.from.id, ctx);
      }
      const text = ctx.message.text;
      if (text.startsWith('/')) return next(); // pass commands to other handlers

      const urlRegex = /(https?:\/\/[^\s]+)/g;
      const urls = text.match(urlRegex);

      if (urls && urls.length > 0) {
        const url = urls[0];
        const isYoutube = url.includes('youtube.com') || url.includes('youtu.be');
        if (url.includes('tiktok.com') || url.includes('instagram.com') || url.includes('facebook.com') || url.includes('fb.watch') || url.includes('threads.net') || isYoutube) {
          if (ctx.from) {
            userManager.incrementStat(ctx.from.id, 'videosDownloaded');
          }
          await processVideoDownload(ctx, url);
        } else {
          await ctx.reply('❌ *Unsupported URL*\n\nI currently only support downloading videos from:\n- YouTube\n- TikTok\n- Instagram\n- Facebook\n- Threads\n\nPlease send a valid link from one of these platforms.', { parse_mode: 'Markdown' });
        }
      }
    });

    bot.action(/retry_video_(.+)/, async (ctx) => {
      const shortId = ctx.match[1];
      const url = pendingVideoRetries.get(shortId);
      
      if (!url) {
        return ctx.answerCbQuery('Retry session expired. Please send the link again.', { show_alert: true });
      }

      await ctx.answerCbQuery('Retrying download...');
      const messageId = (ctx.callbackQuery as any).message?.message_id;
      
      if (ctx.from) {
        userManager.incrementStat(ctx.from.id, 'videosDownloaded');
      }
      
      await processVideoDownload(ctx, url, messageId);
    });

    bot.action(/zip_video_(.+)/, async (ctx) => {
      const shortId = ctx.match[1];
      const videoData = pendingLargeVideos.get(shortId);
      if (!videoData) return ctx.answerCbQuery('Session expired.', { show_alert: true });

      await ctx.answerCbQuery();
      
      const chatId = ctx.chat?.id || 0;
      const messageId = (ctx.callbackQuery as any).message?.message_id || 0;
      
      if (chatId && messageId) {
        await ctx.telegram.editMessageText(chatId, messageId, undefined, '⏳ *Step 1/3:* Starting download for compression...', { parse_mode: 'Markdown' }).catch(() => {});
      }

      try {
        let buffer: Buffer;
        if (videoData.filePath && fs.existsSync(videoData.filePath)) {
          buffer = fs.readFileSync(videoData.filePath);
        } else {
          buffer = await downloadWithProgress(videoData.url, ctx, chatId, messageId, '📥 Downloading for zip');
        }
        
        if (chatId && messageId) {
          await ctx.telegram.editMessageText(chatId, messageId, undefined, '🗜️ *Step 2/3:* Compressing video... This may take a while.', { parse_mode: 'Markdown' }).catch(() => {});
        }
        
        const zippedBuffer = await zipBuffer(buffer, 'video.mp4');
        
        if (chatId && messageId) {
          await ctx.telegram.editMessageText(chatId, messageId, undefined, '📤 *Step 3/3:* Uploading compressed video...', { parse_mode: 'Markdown' }).catch(() => {});
        }
        
        await ctx.replyWithDocument({ source: zippedBuffer, filename: 'video.zip' });
        if (chatId && messageId) {
          await ctx.telegram.deleteMessage(chatId, messageId).catch(() => {});
        }
        await ctx.deleteMessage().catch(() => {});
        if (videoData.filePath && fs.existsSync(videoData.filePath)) {
          fs.unlinkSync(videoData.filePath);
        }
        pendingLargeVideos.delete(shortId);
      } catch (e: any) {
        console.error('Error zipping video:', e.message);
        if (chatId && messageId) {
          await ctx.telegram.editMessageText(chatId, messageId, undefined, 'Failed to compress and send the video.').catch(() => {});
        }
      }
    });

    bot.catch((err, ctx) => {
      console.error(`Ooops, encountered an error for ${ctx.updateType}`, err);
    });

    const dataDir = process.env.DATA_DIR || process.cwd();
    const logFile = path.join(dataDir, 'bot-status.log');

    bot.launch({ dropPendingUpdates: true }).then(() => {
      fs.writeFileSync(logFile, 'Bot launched successfully\n', { flag: 'a' });
      
      // Set bot commands menu
      bot?.telegram.setMyCommands([
        { command: 'start', description: 'Show welcome message and all commands' },
        { command: 'help', description: 'Show help message and available commands' },
        { command: 'setpic', description: 'Set your profile picture' },
        { command: 'tts', description: 'Convert text to speech' },
        { command: 'stats', description: 'View your usage statistics' }
      ]).catch(err => console.error('Failed to set bot commands:', err));
      
    }).catch(err => {
      console.error('Failed to launch Telegram bot:', err);
      fs.writeFileSync(logFile, `Failed to launch: ${err.message}\n`, { flag: 'a' });
      botLaunchError = err.message || String(err);
      bot = null;
    });
    console.log('Telegram bot launched successfully');
    fs.writeFileSync(logFile, 'Bot launch initiated\n', { flag: 'a' });

    // Enable graceful stop
    process.once('SIGINT', () => bot?.stop('SIGINT'));
    process.once('SIGTERM', () => bot?.stop('SIGTERM'));
    } catch (err: any) {
      console.error('Error initializing Telegram bot:', err);
      const dataDir = process.env.DATA_DIR || process.cwd();
      fs.writeFileSync(path.join(dataDir, 'bot-status.log'), `Init error: ${err.message}\n`, { flag: 'a' });
      botLaunchError = err.message || String(err);
      bot = null;
    }
  } else {
    console.log('TELEGRAM_BOT_TOKEN is not set. Bot is not running.');
    const dataDir = process.env.DATA_DIR || process.cwd();
    fs.writeFileSync(path.join(dataDir, 'bot-status.log'), 'No token\n', { flag: 'a' });
  }

  // API Route to check status
  app.get('/api/status', (req, res) => {
    res.json({
      botRunning: !!bot,
      hasToken: !!botToken,
      hasCobaltKey: !!process.env.COBALT_API_KEY,
      hasGemini: !!ai,
      botLaunchError
    });
  });

  // Simple ping endpoint for UptimeRobot
  app.get('/api/ping', (req, res) => {
    res.status(200).send('pong');
  });

  app.get('/api/admin/users', (req, res) => {
    res.json(userManager.getAllUsers());
  });

  app.get('/api/admin/stats', (req, res) => {
    const users = userManager.getAllUsers();
    const totalUsers = users.length;
    const activeUsers = users.filter(u => u.isActive !== false).length;
    const leftUsers = users.filter(u => u.isActive === false).length;
    const totalImages = users.reduce((acc, u) => acc + u.stats.imagesProcessed, 0);
    const totalPdfs = users.reduce((acc, u) => acc + u.stats.pdfsProcessed, 0);
    const totalAudioGen = users.reduce((acc, u) => acc + u.stats.audioGenerated, 0);
    const totalAudioTrans = users.reduce((acc, u) => acc + u.stats.audioTranscribed, 0);
    const totalVideos = users.reduce((acc, u) => acc + u.stats.videosDownloaded, 0);
    
    res.json({
      totalUsers,
      activeUsers,
      leftUsers,
      totalImages,
      totalPdfs,
      totalAudioGen,
      totalAudioTrans,
      totalVideos
    });
  });

  app.get('/api/logs', (req, res) => {
    try {
      const dataDir = process.env.DATA_DIR || process.cwd();
      const logs = fs.readFileSync(path.join(dataDir, 'bot-status.log'), 'utf8');
      res.send(`<pre>${logs}</pre>`);
    } catch (e: any) {
      res.send(`Error reading logs: ${e.message}`);
    }
  });

  app.get('/api/test-gemini', async (req, res) => {
    if (!ai) return res.status(500).json({ error: 'Gemini not initialized' });
    try {
      const response = await ai.models.generateContent({
        model: 'gemini-3-flash-preview',
        contents: 'Say hello world'
      });
      res.json({ success: true, text: response.text });
    } catch (e: any) {
      res.status(500).json({ error: e.message });
    }
  });

  // Vite middleware for development
  if (process.env.NODE_ENV !== "production") {
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: "spa",
    });
    app.use(vite.middlewares);
  } else {
    const distPath = path.join(process.cwd(), 'dist');
    app.use(express.static(distPath));
    app.get('*', (req, res) => {
      res.sendFile(path.join(distPath, 'index.html'));
    });
  }

  const server = app.listen(PORT, "0.0.0.0", () => {
    console.log(`Server running on http://localhost:${PORT}`);
  });

  // Graceful shutdown
  const shutdown = () => {
    console.log('Shutting down gracefully...');
    if (bot) {
      bot.stop('SIGTERM');
    }
    server.close(() => {
      console.log('Server closed.');
      process.exit(0);
    });
    
    // Force close after 5 seconds
    setTimeout(() => {
      console.error('Could not close connections in time, forcefully shutting down');
      process.exit(1);
    }, 5000);
  };

  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
}

startServer();
