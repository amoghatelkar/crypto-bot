import { NextResponse } from 'next/server';
import fs from 'fs';
import path from 'path';

export async function GET() {
  const logPath = path.join(process.cwd(), '../../bot.log'); // adjust path if needed

  try {
    const logs = fs.readFileSync(logPath, 'utf8');
    return new NextResponse(logs, { status: 200 });
  } catch (err) {
    return new NextResponse('Log not found', { status: 404 });
  }
}