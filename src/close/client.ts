import axios, { AxiosInstance } from 'axios';
import axiosRetry from 'axios-retry';
import { config } from '../config';
import type { CloseLeadListResponse, LeadInfo, WhatsAppActivityPayload, WhatsAppActivityResponse } from './types';

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
      if (retryAfter) return parseFloat(retryAfter) * 1000;
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
}

export const closeClient = new CloseApiClient();
