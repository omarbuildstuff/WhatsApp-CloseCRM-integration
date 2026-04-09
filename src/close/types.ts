/** Info extracted from a Close lead for caching and display */
export interface LeadInfo {
  leadId: string;      // 'lead_xxxx'
  leadName: string;
}

/** Phone entry on a Close contact */
export interface CloseContactPhone {
  phone: string;
  phone_formatted: string;
}

/** A contact within a Close lead */
export interface CloseContact {
  id: string;
  phones: CloseContactPhone[];
}

/** A lead returned from Close API search */
export interface CloseLead {
  id: string;
  display_name: string;
  contacts: CloseContact[];
}

/** Response shape for GET /api/v1/lead/?query=... */
export interface CloseLeadListResponse {
  data: CloseLead[];
  has_more: boolean;
  total_results: number;
}

/** Payload for POST /activity/whatsapp_message/ */
export interface WhatsAppActivityPayload {
  lead_id: string;
  direction: 'inbound' | 'outbound';
  external_whatsapp_message_id: string;
  message_markdown: string;
}

/** Response from POST /activity/whatsapp_message/ */
export interface WhatsAppActivityResponse {
  id: string;
}
