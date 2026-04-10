import React, { useEffect, useState } from 'react';
import { Users, BarChart3, Activity, Image as ImageIcon, FileText, Mic, Video, Clock } from 'lucide-react';

interface UserProfile {
  id: number;
  username?: string;
  firstName?: string;
  lastName?: string;
  language?: string;
  isActive?: boolean;
  leftAt?: string;
  stats: {
    imagesProcessed: number;
    pdfsProcessed: number;
    audioGenerated: number;
    audioTranscribed: number;
    videosDownloaded: number;
  };
  firstSeen: string;
  lastSeen: string;
}

interface AdminStats {
  totalUsers: number;
  activeUsers: number;
  leftUsers: number;
  totalImages: number;
  totalPdfs: number;
  totalAudioGen: number;
  totalAudioTrans: number;
  totalVideos: number;
}

export default function AdminDashboard() {
  const [users, setUsers] = useState<UserProfile[]>([]);
  const [stats, setStats] = useState<AdminStats | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const fetchData = async () => {
      try {
        const [usersRes, statsRes] = await Promise.all([
          fetch('/api/admin/users'),
          fetch('/api/admin/stats')
        ]);
        
        if (!usersRes.ok || !statsRes.ok) {
          throw new Error('Server responded with an error');
        }

        const usersData = await usersRes.json();
        const statsData = await statsRes.json();
        
        // Sort users by last seen (most recent first)
        usersData.sort((a: UserProfile, b: UserProfile) => 
          new Date(b.lastSeen).getTime() - new Date(a.lastSeen).getTime()
        );
        
        setUsers(usersData);
        setStats(statsData);
        setError(null);
      } catch (err) {
        console.warn('Failed to fetch admin data. The server might be restarting.', err);
        setError('Unable to connect to the server. Retrying...');
      } finally {
        setLoading(false);
      }
    };

    fetchData();
    // Refresh every 30 seconds
    const interval = setInterval(fetchData, 30000);
    return () => clearInterval(interval);
  }, []);

  if (loading && !users.length) {
    return (
      <div className="flex items-center justify-center h-64">
        <div className="animate-spin rounded-full h-12 w-12 border-b-2 border-blue-600"></div>
      </div>
    );
  }

  return (
    <div className="space-y-8 animate-in fade-in duration-500">
      {error && (
        <div className="bg-yellow-50 border border-yellow-200 text-yellow-800 px-4 py-3 rounded-xl flex items-center gap-3">
          <div className="animate-pulse w-2 h-2 bg-yellow-500 rounded-full"></div>
          {error}
        </div>
      )}

      {/* Stats Overview */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
        <StatCard icon={<Users />} label="Total Users" value={stats?.totalUsers || 0} color="bg-blue-100 text-blue-600" />
        <StatCard icon={<Users />} label="Active Users" value={stats?.activeUsers || 0} color="bg-green-100 text-green-600" />
        <StatCard icon={<Users />} label="Left Users" value={stats?.leftUsers || 0} color="bg-red-100 text-red-600" />
        <StatCard icon={<ImageIcon />} label="Images Processed" value={stats?.totalImages || 0} color="bg-purple-100 text-purple-600" />
        <StatCard icon={<FileText />} label="PDFs Processed" value={stats?.totalPdfs || 0} color="bg-orange-100 text-orange-600" />
        <StatCard icon={<Mic />} label="Audio Transcribed" value={stats?.totalAudioTrans || 0} color="bg-green-100 text-green-600" />
        <StatCard icon={<Activity />} label="Audio Generated" value={stats?.totalAudioGen || 0} color="bg-pink-100 text-pink-600" />
        <StatCard icon={<Video />} label="Videos Downloaded" value={stats?.totalVideos || 0} color="bg-red-100 text-red-600" />
      </div>

      {/* Users Table */}
      <div className="bg-white rounded-2xl shadow-sm border border-gray-100 overflow-hidden">
        <div className="p-6 border-b border-gray-100 flex justify-between items-center">
          <h2 className="text-xl font-semibold flex items-center gap-2">
            <Users className="text-blue-500" size={20} />
            User Directory
          </h2>
          <span className="text-sm text-gray-500">{users.length} registered users</span>
        </div>
        
        <div className="overflow-x-auto">
          <table className="w-full text-left border-collapse">
            <thead>
              <tr className="bg-gray-50 text-gray-500 text-sm border-b border-gray-100">
                <th className="p-4 font-medium">User</th>
                <th className="p-4 font-medium">Status</th>
                <th className="p-4 font-medium">ID</th>
                <th className="p-4 font-medium">Language</th>
                <th className="p-4 font-medium">Activity (Img/PDF/Vid/Aud)</th>
                <th className="p-4 font-medium">Last Seen</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-100">
              {users.length === 0 ? (
                <tr>
                  <td colSpan={5} className="p-8 text-center text-gray-500">
                    No users found yet. Start the bot to register users.
                  </td>
                </tr>
              ) : (
                users.map((user) => (
                  <tr key={user.id} className="hover:bg-gray-50 transition-colors">
                    <td className="p-4">
                      <div className="font-medium text-gray-900">
                        {user.firstName} {user.lastName}
                      </div>
                      {user.username && (
                        <div className="text-sm text-gray-500">@{user.username}</div>
                      )}
                    </td>
                    <td className="p-4">
                      {user.isActive === false ? (
                        <div>
                          <span className="px-2 py-1 bg-red-100 text-red-700 text-xs rounded-full font-medium">Left</span>
                          {user.leftAt && <div className="text-xs text-gray-400 mt-1">{new Date(user.leftAt).toLocaleDateString()}</div>}
                        </div>
                      ) : (
                        <span className="px-2 py-1 bg-green-100 text-green-700 text-xs rounded-full font-medium">Active</span>
                      )}
                    </td>
                    <td className="p-4 text-sm text-gray-500 font-mono">{user.id}</td>
                    <td className="p-4 text-sm">
                      <span className="px-2 py-1 bg-gray-100 rounded text-gray-600 uppercase">
                        {user.language || 'EN'}
                      </span>
                    </td>
                    <td className="p-4 text-sm text-gray-600">
                      <div className="flex gap-3">
                        <span title="Images">{user.stats.imagesProcessed}</span>
                        <span className="text-gray-300">/</span>
                        <span title="PDFs">{user.stats.pdfsProcessed}</span>
                        <span className="text-gray-300">/</span>
                        <span title="Videos">{user.stats.videosDownloaded}</span>
                        <span className="text-gray-300">/</span>
                        <span title="Audio">{user.stats.audioTranscribed + user.stats.audioGenerated}</span>
                      </div>
                    </td>
                    <td className="p-4 text-sm text-gray-500 flex items-center gap-1.5">
                      <Clock size={14} />
                      {new Date(user.lastSeen).toLocaleDateString()} {new Date(user.lastSeen).toLocaleTimeString([], {hour: '2-digit', minute:'2-digit'})}
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}

function StatCard({ icon, label, value, color }: { icon: React.ReactNode, label: string, value: number, color: string }) {
  return (
    <div className="bg-white p-5 rounded-2xl shadow-sm border border-gray-100 flex items-center gap-4">
      <div className={`p-3 rounded-xl ${color}`}>
        {icon}
      </div>
      <div>
        <p className="text-sm text-gray-500 font-medium">{label}</p>
        <p className="text-2xl font-bold text-gray-900">{value}</p>
      </div>
    </div>
  );
}
