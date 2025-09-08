import OpenAI from 'openai';
import { z } from 'zod';
import logger from '../../config/logger';
import { demoProfile } from '../../config/tenantProfile.demo';
import { parseRelativeDateToken, toIsoDate } from '../../utils/datetime';
import { getBookingsList } from '../booking/booking.service';

export type NluResult = {
  intent: 'booking.create' | 'booking.modify' | 'booking.cancel' | 'booking.list' | 'availability.query' | 'info.menu' | 'info.address' | 'info.opening' | 'info.parking' | 'greeting' | 'unknown' | 'general.chat';
  confidence: number;
  fields: { date?: string; time?: string; people?: number; name?: string; phone?: string; notes?: string; booking_id?: string };
  missing_fields: string[];
  reply?: string;
  next_action: 'check_availability' | 'ask_missing' | 'answer_smalltalk' | 'list_show' | 'send_info' | 'cancel_confirm' | 'modify_propose' | 'none';
};

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
const MODEL = process.env.OPENAI_MODEL || 'gpt-4o-mini';


export async function parseBookingIntent(
  _text: string,
  _context?: { phone?: string; locale?: string; timezone?: string },
): Promise<NluResult> {
  return {
    intent: 'unknown',
    confidence: 0,
    fields: {},
    missing_fields: [],
    next_action: 'none',
  };
}
