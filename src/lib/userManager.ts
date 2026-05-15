import fs from 'fs';
import path from 'path';

export interface UserProfile {
  id: number;
  username?: string;
  firstName?: string;
  lastName?: string;
  language?: string;
  profilePicFileId?: string;
  stats: {
    imagesProcessed: number;
    pdfsProcessed: number;
    audioGenerated: number;
    audioTranscribed: number;
    videosDownloaded: number;
  };
  isActive?: boolean;
  leftAt?: string;
  firstSeen: string;
  lastSeen: string;
}

const dataDir = process.env.DATA_DIR || process.cwd();
const USERS_FILE = path.join(dataDir, 'users.json');

class UserManager {
  private users: Map<number, UserProfile> = new Map();

  private isSaving = false;
  private pendingSave = false;

  constructor() {
    this.loadUsers();
    this.updateInactiveUsers();
    // Check for inactive users every 24 hours
    setInterval(() => this.updateInactiveUsers(), 24 * 60 * 60 * 1000);
  }

  public updateInactiveUsers(days: number = 30) {
    const now = Date.now();
    const msInDay = 24 * 60 * 60 * 1000;
    let updated = false;

    for (const user of this.users.values()) {
      if (user.isActive !== false && user.lastSeen) {
        const lastSeenDate = new Date(user.lastSeen).getTime();
        if (now - lastSeenDate > days * msInDay) {
          user.isActive = false;
          user.leftAt = new Date().toISOString();
          updated = true;
        }
      }
    }

    if (updated) {
      this.saveUsers();
    }
  }

  private loadUsers() {
    let success = false;
    for (let i = 0; i < 3; i++) {
      try {
        if (fs.existsSync(USERS_FILE)) {
          const data = fs.readFileSync(USERS_FILE, 'utf-8');
          const parsed = JSON.parse(data);
          for (const [id, profile] of Object.entries(parsed)) {
            this.users.set(Number(id), profile as UserProfile);
          }
        }
        success = true;
        break;
      } catch (e) {
        console.error(`Failed to load users (attempt ${i + 1}/3):`, e);
        // synchronous sleep for 200ms
        const start = Date.now();
        while (Date.now() - start < 200) {}
      }
    }
    if (!success) {
      console.error('CRITICAL: Failed to read users.json after 3 attempts. Starting with empty users map.');
    }
  }

  private async saveUsers() {
    if (this.isSaving) {
      this.pendingSave = true;
      return;
    }
    this.isSaving = true;
    this.pendingSave = false;

    const obj = Object.fromEntries(this.users);
    const data = JSON.stringify(obj, null, 2);

    let success = false;
    for (let i = 0; i < 3; i++) {
      try {
        await fs.promises.writeFile(USERS_FILE, data, 'utf-8');
        success = true;
        break;
      } catch (e) {
        console.error(`Failed to save users (attempt ${i + 1}/3):`, e);
        await new Promise(resolve => setTimeout(resolve, 200));
      }
    }

    if (!success) {
      console.error('CRITICAL: Failed to write to users.json after 3 attempts.');
    }

    this.isSaving = false;
    if (this.pendingSave) {
      this.saveUsers();
    }
  }

  public getUser(id: number, ctx?: any): UserProfile {
    let user = this.users.get(id);
    const now = new Date().toISOString();
    
    if (!user) {
      user = {
        id,
        username: ctx?.from?.username,
        firstName: ctx?.from?.first_name,
        lastName: ctx?.from?.last_name,
        language: 'en', // default
        stats: {
          imagesProcessed: 0,
          pdfsProcessed: 0,
          audioGenerated: 0,
          audioTranscribed: 0,
          videosDownloaded: 0
        },
        isActive: true,
        firstSeen: now,
        lastSeen: now
      };
      this.users.set(id, user);
      this.saveUsers();
    } else {
      // Update last seen and profile info if available
      user.lastSeen = now;
      user.isActive = true;
      user.leftAt = undefined;
      if (ctx?.from) {
        if (ctx.from.username) user.username = ctx.from.username;
        if (ctx.from.first_name) user.firstName = ctx.from.first_name;
        if (ctx.from.last_name) user.lastName = ctx.from.last_name;
      }
      this.saveUsers();
    }
    
    return user;
  }

  public setLanguage(id: number, language: string) {
    const user = this.users.get(id);
    if (user) {
      user.language = language;
      this.saveUsers();
    }
  }

  public setUserStatus(id: number, isActive: boolean) {
    const user = this.users.get(id);
    if (user) {
      user.isActive = isActive;
      if (!isActive) {
        user.leftAt = new Date().toISOString();
      } else {
        user.leftAt = undefined;
      }
      this.saveUsers();
    }
  }

  public incrementStat(id: number, stat: keyof UserProfile['stats']) {
    const user = this.users.get(id);
    if (user) {
      user.stats[stat]++;
      this.saveUsers();
    }
  }
  
  public getAllUsers(): UserProfile[] {
    return Array.from(this.users.values());
  }

  public hasUser(id: number): boolean {
    return this.users.has(id);
  }

  public getExistingUser(id: number): UserProfile | undefined {
    return this.users.get(id);
  }

  public setProfilePic(id: number, fileId: string) {
    const user = this.users.get(id);
    if (user) {
      user.profilePicFileId = fileId;
      this.saveUsers();
    }
  }
}

export const userManager = new UserManager();
