import axios, { AxiosInstance } from 'axios';
import axiosRetry from 'axios-retry';
import pino from 'pino';
import { config } from '../config';
import type { CloseLeadListResponse, CloseLead, LeadInfo, WhatsAppActivityPayload, WhatsAppActivityResponse, WhatsAppActivityUpdatePayload } from './types';

const logger = pino({ level: process.env.LOG_LEVEL ?? 'info' });

const CLOSE_BASE_URL = 'https://api.close.com/api/v1';

function createCloseAxios(): AxiosInstance {
  const instance = axios.create({
    baseURL: CLOSE_BASE_URL,
    auth: { username: config.closeApiKey, password: '' },
    timeout: 10_000,
  });

  axiosRetry(instance, {
    retries: 3,
    retryCondition: (err) =>
      axiosRetry.isNetworkError(err) ||
      err.response?.status === 429 ||
      (err.response?.status ?? 0) >= 500,
    retryDelay: (retryCount, err) => {
      const retryAfter = err.response?.headers?.['retry-after'];
      if (retryAfter) {
        const seconds = parseFloat(retryAfter);
        if (!isNaN(seconds)) return seconds * 1000;
        // HTTP-date format fallback (e.g. "Thu, 10 Apr 2026 01:00:00 GMT")
        const targetMs = Date.parse(retryAfter);
        if (!isNaN(targetMs)) return Math.max(0, targetMs - Date.now());
      }
      return axiosRetry.exponentialDelay(retryCount);
    },
  });

  return instance;
}

export class CloseApiClient {
  private readonly http: AxiosInstance;

  constructor() {
    this.http = createCloseAxios();
  }

  async findLeadByPhone(e164: string): Promise<LeadInfo | null> {
    const res = await this.http.get<CloseLeadListResponse>('/lead/', {
      params: {
        query: `phone:${e164}`,
        _fields: 'id,display_name',
        _limit: 1,
      },
    });
    const leads = res.data?.data;
    if (!Array.isArray(leads)) {
      throw new Error(
        `Unexpected Close API response shape for phone lookup: ${JSON.stringify(res.data)}`
      );
    }
    const lead = leads[0];
    if (!lead) return null;
    return { leadId: lead.id, leadName: lead.display_name };
  }

  async postWhatsAppActivity(payload: WhatsAppActivityPayload): Promise<string | null> {
    const res = await this.http.post<WhatsAppActivityResponse>(
      '/activity/whatsapp_message/',
      payload
    );
    return res.data?.id ?? null;
  }

  async updateWhatsAppActivity(
    activityId: string,
    patch: WhatsAppActivityUpdatePayload
  ): Promise<void> {
    try {
      await this.http.patch(`/activity/whatsapp_message/${activityId}/`, patch);
    } catch (err) {
      // Non-critical: the WA message was already sent. Log and continue.
      logger.error(
        { activityId, err },
        'Failed to update Close activity with WA message ID — non-critical'
      );
    }
  }

  /**
   * Find the contact_id on a lead whose phone matches remotePhone.
   * Falls back to the first contact if no exact phone match.
   */
  async findContactId(leadId: string, remotePhone: string): Promise<string | null> {
    try {
      const res = await this.http.get<CloseLead>(`/lead/${leadId}/`, {
        params: { _fields: 'contacts' },
      });
      const contacts = res.data?.contacts ?? [];
      const targetDigits = remotePhone.replace(/\D/g, '');
      for (const contact of contacts) {
        for (const phone of contact.phones) {
          if (phone.phone.replace(/\D/g, '') === targetDigits) {
            return contact.id;
          }
        }
      }
      // Fallback: lead was matched by phone, first contact is likely correct
      return contacts[0]?.id ?? null;
    } catch (err) {
      logger.error({ leadId, remotePhone, err }, 'Failed to find contact ID');
      return null;
    }
  }

  async getLeadContacts(leadId: string): Promise<string | null> {
    try {
      const res = await this.http.get<CloseLead>(`/lead/${leadId}/`, {
        params: { _fields: 'contacts' },
      });
      const phone = res.data?.contacts?.[0]?.phones?.[0]?.phone ?? null;
      return phone;
    } catch (err) {
      logger.error({ leadId, err }, 'Failed to fetch lead contacts from Close');
      return null;
    }
  }
}

export const closeClient = new CloseApiClient();
