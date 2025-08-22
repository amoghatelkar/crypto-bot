'use client';
import { useEffect, useState } from 'react';

export default function Home() {
  const [logs, setLogs] = useState<string[]>([]);

  useEffect(() => {
    const fetchLogs = async () => {
      const res = await fetch('/api/logs');
      const text = await res.text();
      setLogs(text.split('\n').filter(Boolean).slice(-100)); // last 100 lines
    };

    fetchLogs();
    const interval = setInterval(fetchLogs, 5000); // refresh every 5 sec

    return () => clearInterval(interval);
  }, []);

  return (
    <div className="bg-black text-green-400 p-4 font-mono h-screen overflow-y-scroll">
      {logs.map((line, idx) => (
        <p key={idx}>{line}</p>
      ))}
    </div>
  );
}