import { corsPreflight, json, metadata } from '@/lib/metadata';

export const dynamic = 'force-dynamic';
export const GET = () => json(metadata(), 200, { 'cache-control': 'public, max-age=300' });
export const OPTIONS = corsPreflight;
