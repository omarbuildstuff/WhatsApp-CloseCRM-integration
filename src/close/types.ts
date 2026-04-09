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
  date?: string;   // ISO 8601 — activity timestamp in Close
}

/** Response from POST /activity/whatsapp_message/ */
export interface WhatsAppActivityResponse {
  id: string;
}

/** Close webhook event envelope */
export interface CloseWebhookEvent {
  event: {
    id: string;
    date_created: string;
    date_updated: string;
    object_type: string;
    action: string;
    organization_id: string;
    data: CloseWebhookActivityData;
  };
}

/** Data payload within a Close webhook event for WhatsApp activities */
export interface CloseWebhookActivityData {
  id: string;                                // Close activity ID (actwh_xxx)
  lead_id: string;                           // Close lead ID
  user_id: string;                           // Close user who created activity
  direction: 'inbound' | 'outbound';
  message_markdown: string;
  external_whatsapp_message_id: string | null;
  date_created: string;
  date_updated: string;
}

/** Payload for PUT /activity/whatsapp_message/{id}/ to update activity */
export interface WhatsAppActivityUpdatePayload {
  external_whatsapp_message_id: string;
}
