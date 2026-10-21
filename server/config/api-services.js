// server/config/api-services.js
// External API service configuration registry.
// Centralizes all third-party API credentials and endpoints for payment gateways,
// OTA channels, SMS/email providers, and other integrations. Each tenant can
// override these with their own keys (stored in tenant_api_configs table).

'use strict';

/**
 * API Service Categories:
 * - payment_gateway: Stripe, Paystack, Flutterwave, Square, etc.
 * - ota_channel: Booking.com, Expedia, Airbnb API integrations
 * - sms_provider: Twilio, Vonage, Africa's Talking, Termii
 * - email_provider: SendGrid, Mailgun, AWS SES, Resend
 * - notification: Push notification services (FCM, OneSignal)
 * - analytics: Google Analytics, Mixpanel, Segment
 * - storage: AWS S3, Cloudinary, DigitalOcean Spaces
 * - door_lock: Hotel door locks (Seam, ASSA ABLOY/VingCard, SALTO, TTLock, ZKTeco…)
 * - iptv_vod: Hotel TV / video-on-demand platforms (mwareTV, AlphaOTT, VITEC…)
 * - internet_management: Guest Wi-Fi & network controllers (UniFi, Meraki, MikroTik…)
 * - room_automation: In-room lighting/TV/speaker control (Control4, KNX, Hue, Sonos…)
 * - iot_platform: Zigbee coordinators, camera/NVR APIs (Hikvision ISAPI, Dahua), generic IoT clouds
 */

const SERVICE_DEFINITIONS = {
  // ── Payment Gateways ──────────────────────────────────────────────────
  stripe: {
    name: 'Stripe',
    category: 'payment_gateway',
    baseUrl: 'https://api.stripe.com',
    credentials: [
      { key: 'publishable_key', label: 'Publishable Key', required: true, public: true },
      { key: 'secret_key', label: 'Secret Key', required: true, public: false },
      { key: 'webhook_secret', label: 'Webhook Secret', required: false, public: false },
    ],
    testMode: { key: 'test_mode', default: false },
    docs: 'https://stripe.com/docs/api',
  },

  paystack: {
    name: 'Paystack',
    category: 'payment_gateway',
    baseUrl: 'https://api.paystack.co',
    credentials: [
      { key: 'public_key', label: 'Public Key', required: true, public: true },
      { key: 'secret_key', label: 'Secret Key', required: true, public: false },
    ],
    testMode: { key: 'test_mode', default: false },
    docs: 'https://paystack.com/docs/api',
  },

  flutterwave: {
    name: 'Flutterwave',
    category: 'payment_gateway',
    baseUrl: 'https://api.flutterwave.com/v3',
    credentials: [
      { key: 'public_key', label: 'Public Key', required: true, public: true },
      { key: 'secret_key', label: 'Secret Key', required: true, public: false },
      { key: 'encryption_key', label: 'Encryption Key', required: true, public: false },
    ],
    testMode: { key: 'test_mode', default: false },
    docs: 'https://developer.flutterwave.com/docs',
  },

  korapay: {
    name: 'Korapay (Kora)',
    category: 'payment_gateway',
    baseUrl: 'https://api.korapay.com/merchant/api/v1',
    credentials: [
      { key: 'public_key', label: 'Public Key', required: true, public: true },
      { key: 'secret_key', label: 'Secret Key', required: true, public: false },
    ],
    testMode: { key: 'test_mode', default: false },
    docs: 'https://developers.korapay.com/docs',
  },

  square: {
    name: 'Square',
    category: 'payment_gateway',
    baseUrl: 'https://connect.squareup.com',
    credentials: [
      { key: 'application_id', label: 'Application ID', required: true, public: true },
      { key: 'access_token', label: 'Access Token', required: true, public: false },
      { key: 'location_id', label: 'Location ID', required: true, public: false },
    ],
    testMode: { key: 'sandbox', default: false },
    docs: 'https://developer.squareup.com/docs',
  },

  // ── OTA Channel APIs ──────────────────────────────────────────────────
  booking_com: {
    name: 'Booking.com',
    category: 'ota_channel',
    baseUrl: 'https://distribution-xml.booking.com',
    credentials: [
      { key: 'hotel_id', label: 'Property ID', required: true, public: false },
      { key: 'username', label: 'API Username', required: true, public: false },
      { key: 'password', label: 'API Password', required: true, public: false },
    ],
    docs: 'https://connect.booking.com/user_guide/site/en-US/',
  },

  expedia: {
    name: 'Expedia',
    category: 'ota_channel',
    baseUrl: 'https://services.expediapartnercentral.com',
    credentials: [
      { key: 'property_id', label: 'Property ID', required: true, public: false },
      { key: 'api_key', label: 'API Key', required: true, public: false },
      { key: 'secret', label: 'Shared Secret', required: true, public: false },
    ],
    docs: 'https://developer.expedia.com/',
  },

  airbnb: {
    name: 'Airbnb',
    category: 'ota_channel',
    baseUrl: 'https://api.airbnb.com',
    credentials: [
      { key: 'client_id', label: 'Client ID', required: true, public: false },
      { key: 'client_secret', label: 'Client Secret', required: true, public: false },
      { key: 'listing_id', label: 'Listing ID', required: true, public: false },
    ],
    docs: 'https://www.airbnb.com/partner',
  },

  // ── SMS Providers ─────────────────────────────────────────────────────
  twilio: {
    name: 'Twilio',
    category: 'sms_provider',
    baseUrl: 'https://api.twilio.com/2010-04-01',
    credentials: [
      { key: 'account_sid', label: 'Account SID', required: true, public: false },
      { key: 'auth_token', label: 'Auth Token', required: true, public: false },
      { key: 'from_number', label: 'From Phone Number', required: true, public: false },
    ],
    docs: 'https://www.twilio.com/docs/sms',
  },

  vonage: {
    name: 'Vonage (Nexmo)',
    category: 'sms_provider',
    baseUrl: 'https://rest.nexmo.com',
    credentials: [
      { key: 'api_key', label: 'API Key', required: true, public: false },
      { key: 'api_secret', label: 'API Secret', required: true, public: false },
      { key: 'from_name', label: 'Sender Name', required: false, public: false },
    ],
    docs: 'https://developer.vonage.com/messaging/sms/overview',
  },

  africas_talking: {
    name: "Africa's Talking",
    category: 'sms_provider',
    baseUrl: 'https://api.africastalking.com/version1',
    credentials: [
      { key: 'username', label: 'Username', required: true, public: false },
      { key: 'api_key', label: 'API Key', required: true, public: false },
      { key: 'from_shortcode', label: 'Shortcode/Sender ID', required: false, public: false },
    ],
    docs: 'https://developers.africastalking.com/docs/sms/overview',
  },

  termii: {
    name: 'Termii',
    category: 'sms_provider',
    baseUrl: 'https://api.ng.termii.com/api',
    credentials: [
      { key: 'api_key', label: 'API Key', required: true, public: false },
      { key: 'sender_id', label: 'Sender ID', required: true, public: false },
    ],
    docs: 'https://developers.termii.com/',
  },

  // ── Email Providers ───────────────────────────────────────────────────
  sendgrid: {
    name: 'SendGrid',
    category: 'email_provider',
    baseUrl: 'https://api.sendgrid.com/v3',
    credentials: [
      { key: 'api_key', label: 'API Key', required: true, public: false },
      { key: 'from_email', label: 'From Email', required: true, public: false },
      { key: 'from_name', label: 'From Name', required: false, public: false },
    ],
    docs: 'https://docs.sendgrid.com/api-reference',
  },

  mailgun: {
    name: 'Mailgun',
    category: 'email_provider',
    baseUrl: 'https://api.mailgun.net/v3',
    credentials: [
      { key: 'api_key', label: 'API Key', required: true, public: false },
      { key: 'domain', label: 'Domain', required: true, public: false },
      { key: 'from_email', label: 'From Email', required: true, public: false },
    ],
    docs: 'https://documentation.mailgun.com/en/latest/api_reference.html',
  },

  resend: {
    name: 'Resend',
    category: 'email_provider',
    baseUrl: 'https://api.resend.com',
    credentials: [
      { key: 'api_key', label: 'API Key', required: true, public: false },
      { key: 'from_email', label: 'From Email', required: true, public: false },
    ],
    docs: 'https://resend.com/docs',
  },

  aws_ses: {
    name: 'AWS SES',
    category: 'email_provider',
    baseUrl: 'https://email.{region}.amazonaws.com',
    credentials: [
      { key: 'access_key_id', label: 'Access Key ID', required: true, public: false },
      { key: 'secret_access_key', label: 'Secret Access Key', required: true, public: false },
      { key: 'region', label: 'AWS Region', required: true, public: false },
      { key: 'from_email', label: 'From Email', required: true, public: false },
    ],
    docs: 'https://docs.aws.amazon.com/ses/',
  },

  // ── Push Notifications ────────────────────────────────────────────────
  fcm: {
    name: 'Firebase Cloud Messaging',
    category: 'notification',
    baseUrl: 'https://fcm.googleapis.com/v1',
    credentials: [
      { key: 'project_id', label: 'Project ID', required: true, public: false },
      { key: 'private_key', label: 'Service Account Private Key (JSON)', required: true, public: false },
    ],
    docs: 'https://firebase.google.com/docs/cloud-messaging',
  },

  onesignal: {
    name: 'OneSignal',
    category: 'notification',
    baseUrl: 'https://onesignal.com/api/v1',
    credentials: [
      { key: 'app_id', label: 'App ID', required: true, public: true },
      { key: 'rest_api_key', label: 'REST API Key', required: true, public: false },
    ],
    docs: 'https://documentation.onesignal.com/reference',
  },

  // ── Cloud Storage ─────────────────────────────────────────────────────
  aws_s3: {
    name: 'AWS S3',
    category: 'storage',
    baseUrl: 'https://s3.{region}.amazonaws.com',
    credentials: [
      { key: 'access_key_id', label: 'Access Key ID', required: true, public: false },
      { key: 'secret_access_key', label: 'Secret Access Key', required: true, public: false },
      { key: 'region', label: 'AWS Region', required: true, public: false },
      { key: 'bucket', label: 'Bucket Name', required: true, public: false },
    ],
    docs: 'https://docs.aws.amazon.com/s3/',
  },

  cloudinary: {
    name: 'Cloudinary',
    category: 'storage',
    baseUrl: 'https://api.cloudinary.com/v1_1',
    credentials: [
      { key: 'cloud_name', label: 'Cloud Name', required: true, public: true },
      { key: 'api_key', label: 'API Key', required: true, public: false },
      { key: 'api_secret', label: 'API Secret', required: true, public: false },
    ],
    docs: 'https://cloudinary.com/documentation',
  },

  // ── Analytics ─────────────────────────────────────────────────────────
  google_analytics: {
    name: 'Google Analytics 4',
    category: 'analytics',
    baseUrl: 'https://www.googleapis.com/analytics/v3',
    credentials: [
      { key: 'measurement_id', label: 'Measurement ID', required: true, public: true },
      { key: 'api_secret', label: 'API Secret', required: false, public: false },
    ],
    docs: 'https://developers.google.com/analytics',
  },

  // ── Hotel Door Locks ──────────────────────────────────────────────────
  // Doors are coded on check-in: set PIN / mobile key for the stay window,
  // expire on checkout. All credentials are encrypted at rest.

  // Seam is the hardware-agnostic lock API (Yale, Schlage, August, SmartThings,
  // 2N…) — the fastest way to support many lock brands through one integration.
  seam: {
    name: 'Seam (universal lock API)',
    category: 'door_lock',
    baseUrl: 'https://connect.getseam.com',
    credentials: [
      { key: 'api_key', label: 'Seam API Key (seam_…)', required: true, public: false },
    ],
    docs: 'https://docs.seam.co/latest',
  },

  // ASSA ABLOY Global Solutions (VingCard) — the world's largest hotel lock
  // vendor (Alliance / VisionLine / Mobile Access). Their REST API is provided
  // per-property; base URL and keys come from your AGS integration agreement.
  assa_abloy_vingcard: {
    name: 'ASSA ABLOY Global Solutions (VingCard)',
    category: 'door_lock',
    baseUrl: null, // per-property server from your AGS agreement
    credentials: [
      { key: 'server_url', label: 'AGS API Server URL', required: true, public: false },
      { key: 'client_id', label: 'Client ID', required: true, public: false },
      { key: 'client_secret', label: 'Client Secret', required: true, public: false },
      { key: 'property_id', label: 'Property / System ID', required: false, public: false },
    ],
    docs: 'https://www.assaabloyglobalsolutions.com',
  },

  // SALTO Systems — Space / REST encoder API (on-prem SALTO Space server).
  salto_systems: {
    name: 'SALTO Systems',
    category: 'door_lock',
    baseUrl: null, // on-prem Space server URL
    credentials: [
      { key: 'server_url', label: 'SALTO Space Server URL', required: true, public: false },
      { key: 'api_key', label: 'API Key / Subscription Key', required: true, public: false },
      { key: 'encoder_id', label: 'Default Encoder ID', required: false, public: false },
    ],
    docs: 'https://www.saltosystems.com/en/integrations',
  },

  // TTLock (Smart Lock) — cloud API used by hundreds of white-label lock brands.
  ttlock: {
    name: 'TTLock Cloud',
    category: 'door_lock',
    baseUrl: 'https://api.ttlock.com/v3',
    credentials: [
      { key: 'client_id', label: 'Client ID', required: true, public: false },
      { key: 'client_secret', label: 'Client Secret', required: true, public: false },
      { key: 'username', label: 'Account Username', required: true, public: false },
      { key: 'password', label: 'Account Password', required: true, public: false },
    ],
    docs: 'https://euopen.ttlock.com/document',
  },

  zkteco: {
    name: 'ZKTeco',
    category: 'door_lock',
    baseUrl: null, // device/controller host on the local network
    credentials: [
      { key: 'device_host', label: 'Controller Host / IP', required: true, public: false },
      { key: 'device_port', label: 'API Port', required: false, public: false },
      { key: 'username', label: 'Device Username', required: false, public: false },
      { key: 'password', label: 'Device Password', required: false, public: false },
    ],
    docs: 'https://www.zkteco.com',
  },

  onity: {
    name: 'Onity (DirectKey)',
    category: 'door_lock',
    baseUrl: null, // per-property DirectKey gateway
    credentials: [
      { key: 'gateway_url', label: 'DirectKey Gateway URL', required: true, public: false },
      { key: 'api_key', label: 'API Key', required: true, public: false },
      { key: 'api_secret', label: 'API Secret', required: true, public: false },
    ],
    docs: 'https://onity.com',
  },

  dormakaba: {
    name: 'dormakaba',
    category: 'door_lock',
    baseUrl: null, // per-property Amba/Spermann gateway
    credentials: [
      { key: 'gateway_url', label: 'Gateway / Interface URL', required: true, public: false },
      { key: 'api_key', label: 'API Key', required: true, public: false },
      { key: 'api_secret', label: 'API Secret', required: true, public: false },
      { key: 'system_id', label: 'System ID', required: false, public: false },
    ],
    docs: 'https://www.dormakaba.com',
  },

  remotelock: {
    name: 'RemoteLock (aggregator)',
    category: 'door_lock',
    baseUrl: 'https://api.remotelock.com',
    credentials: [
      { key: 'access_token', label: 'OAuth Access Token', required: true, public: false },
    ],
    docs: 'https://apidocs.remotelock.com',
  },

  // ── IPTV & VOD ────────────────────────────────────────────────────────
  // Guest-facing TV: welcome page with hotel branding, VOD library, folio view,
  // room-service ordering on the TV. Server-side credentials stay encrypted.

  mwaretv: {
    name: 'mwareTV',
    category: 'iptv_vod',
    baseUrl: null, // per-tenant platform URL
    credentials: [
      { key: 'platform_url', label: 'Platform URL', required: true, public: false },
      { key: 'api_key', label: 'API Key', required: true, public: false },
      { key: 'property_id', label: 'Property ID', required: false, public: false },
    ],
    docs: 'https://www.mwaretv.com',
  },

  hottv_vod: {
    name: 'HotelTV / VOD Server',
    category: 'iptv_vod',
    baseUrl: null, // self-hosted server
    credentials: [
      { key: 'server_host', label: 'Server Host / IP', required: true, public: false },
      { key: 'server_port', label: 'Port', required: false, public: false },
      { key: 'api_key', label: 'API Key', required: true, public: false },
    ],
    docs: null,
  },

  alphaott: {
    name: 'AlphaOTT',
    category: 'iptv_vod',
    baseUrl: null, // per-tenant OTT platform URL
    credentials: [
      { key: 'platform_url', label: 'Platform URL', required: true, public: false },
      { key: 'api_key', label: 'API Key', required: true, public: false },
      { key: 'api_secret', label: 'API Secret', required: false, public: false },
    ],
    docs: 'https://alphaott.com',
  },

  vitec: {
    name: 'VITEC (EZ-Runner / EZ Room)',
    category: 'iptv_vod',
    baseUrl: null, // on-prem management host
    credentials: [
      { key: 'server_host', label: 'Management Server Host / IP', required: true, public: false },
      { key: 'api_key', label: 'API Key / Token', required: true, public: false },
    ],
    docs: 'https://www.vitec.com',
  },

  samsung_lynk: {
    name: 'Samsung LYNK Cloud',
    category: 'iptv_vod',
    baseUrl: 'https://sdk.samsungcloudsolution.net',
    credentials: [
      { key: 'api_key', label: 'API Key', required: true, public: false },
      { key: 'tenant_id', label: 'Tenant ID', required: true, public: false },
    ],
    docs: 'https://www.samsung.com/business',
  },

  lg_procentric: {
    name: 'LG Pro:Centric Direct',
    category: 'iptv_vod',
    baseUrl: null, // on-prem Pro:Centric server
    credentials: [
      { key: 'server_host', label: 'Pro:Centric Server Host / IP', required: true, public: false },
      { key: 'api_key', label: 'API Key', required: false, public: false },
    ],
    docs: 'https://www.lg.com/business',
  },

  // ── Internet Management ───────────────────────────────────────────────
  // Per-room guest Wi-Fi: speed tiers by booking, voucher/quota control,
  // captive-portal room binding — all resolved from the tenant's controller.

  unifi: {
    name: 'Ubiquiti UniFi Controller',
    category: 'internet_management',
    baseUrl: null, // self-hosted controller URL
    credentials: [
      { key: 'controller_url', label: 'Controller URL (https://host:8443)', required: true, public: false },
      { key: 'username', label: 'Controller Username', required: true, public: false },
      { key: 'password', label: 'Controller Password', required: true, public: false },
      { key: 'site_id', label: 'Site ID (default: default)', required: false, public: false },
    ],
    docs: 'https://ubntwiki.com/products/software/unifi_controller/api',
  },

  meraki: {
    name: 'Cisco Meraki Dashboard',
    category: 'internet_management',
    baseUrl: 'https://api.meraki.com/api/v1',
    credentials: [
      { key: 'api_key', label: 'Dashboard API Key', required: true, public: false },
      { key: 'organization_id', label: 'Organization ID', required: false, public: false },
    ],
    docs: 'https://developer.cisco.com/meraki/api-v1',
  },

  mikrotik: {
    name: 'MikroTik RouterOS (REST)',
    category: 'internet_management',
    baseUrl: null, // router REST endpoint (RouterOS v7+)
    credentials: [
      { key: 'router_host', label: 'Router Host / IP', required: true, public: false },
      { key: 'router_port', label: 'REST Port (default 443)', required: false, public: false },
      { key: 'username', label: 'Username', required: true, public: false },
      { key: 'password', label: 'Password', required: true, public: false },
    ],
    docs: 'https://help.mikrotik.com/docs/display/ROS/REST+API',
  },

  omada: {
    name: 'TP-Link Omada Controller',
    category: 'internet_management',
    baseUrl: null, // controller URL
    credentials: [
      { key: 'controller_url', label: 'Controller URL', required: true, public: false },
      { key: 'client_id', label: 'Client ID', required: true, public: false },
      { key: 'client_secret', label: 'Client Secret', required: true, public: false },
      { key: 'omada_site', label: 'Site Name', required: false, public: false },
    ],
    docs: 'https://community.tp-link.com/en/business/forum/topic/676986',
  },

  ruckus: {
    name: 'Ruckus Networks',
    category: 'internet_management',
    baseUrl: null, // cloud or on-prem controller
    credentials: [
      { key: 'controller_url', label: 'Cloud / Controller URL', required: true, public: false },
      { key: 'api_key', label: 'API Key / Token', required: true, public: false },
    ],
    docs: 'https://support.ruckuswireless.com',
  },

  // ── Room Automation (lighting, TV, speakers, scenes) ─────────────────
  // Check-in triggers a welcome scene (lights to 60%, TV on, curtains open);
  // DND from the phone controls the room; checkout resets to eco mode.

  control4: {
    name: 'Control4',
    category: 'room_automation',
    baseUrl: null, // local Control4 controller
    credentials: [
      { key: 'director_url', label: 'Controller (Director) URL', required: true, public: false },
      { key: 'username', label: 'Composer Username', required: true, public: false },
      { key: 'password', label: 'Composer Password', required: true, public: false },
    ],
    docs: 'https://www.control4.com',
  },

  crestron: {
    name: 'Crestron Home',
    category: 'room_automation',
    baseUrl: null, // local processor
    credentials: [
      { key: 'processor_url', label: 'Processor URL', required: true, public: false },
      { key: 'api_token', label: 'API Token', required: false, public: false },
    ],
    docs: 'https://www.crestron.com',
  },

  knx: {
    name: 'KNX (IP Gateway)',
    category: 'room_automation',
    baseUrl: null, // KNXnet/IP router or tunnel on the local network
    credentials: [
      { key: 'gateway_host', label: 'Gateway Host / IP', required: true, public: false },
      { key: 'gateway_port', label: 'Tunnel Port (default 3671)', required: false, public: false },
    ],
    docs: 'https://www.knx.org',
  },

  lutron: {
    name: 'Lutron (HomeWorks / RA3)',
    category: 'room_automation',
    baseUrl: null, // local processor
    credentials: [
      { key: 'processor_host', label: 'Processor Host / IP', required: true, public: false },
      { key: 'username', label: 'Integration Username', required: false, public: false },
      { key: 'password', label: 'Integration Password', required: false, public: false },
    ],
    docs: 'https://www.lutron.com',
  },

  philips_hue: {
    name: 'Philips Hue Bridge',
    category: 'room_automation',
    baseUrl: null, // local bridge
    credentials: [
      { key: 'bridge_host', label: 'Bridge IP', required: true, public: false },
      { key: 'app_key', label: 'App Key (username)', required: true, public: false },
    ],
    docs: 'https://developers.meethue.com',
  },

  sonos: {
    name: 'Sonos Control (cloud)',
    category: 'room_automation',
    baseUrl: 'https://api.sonos.com',
    credentials: [
      { key: 'client_id', label: 'Client ID', required: true, public: false },
      { key: 'client_secret', label: 'Client Secret', required: true, public: false },
    ],
    docs: 'https://developer.sonos.com',
  },

  // ── Zigbee / IoT & Camera / Device APIs ────────────────────────────
  // The Zigbee coordinator bridges low-power room sensors (door/window
  // contacts, motion, thermostats, smart plugs) into the automation layer;
  // Hikvision/Dahua bridge cameras and NVRs; the generic IoT platform is the
  // umbrella MQTT/HTTP device cloud some properties already run.

  // Zigbee2MQTT exposes a friendly HTTP + WebSocket API on the coordinator.
  zigbee: {
    name: 'Zigbee Gateway (Zigbee2MQTT)',
    category: 'iot_platform',
    baseUrl: null, // self-hosted coordinator
    credentials: [
      { key: 'gateway_host', label: 'Coordinator Host / IP', required: true, public: false },
      { key: 'gateway_port', label: 'API Port (default 8080)', required: false, public: false },
      { key: 'access_token', label: 'Auth Token (if set)', required: false, public: false },
    ],
    docs: 'https://www.zigbee2mqtt.io/guide/api/',
  },

  // Hikvision ISAPI — the standard HTTP API on cameras/NVRs (port 80/8000).
  hikvision: {
    name: 'Hikvision (ISAPI)',
    category: 'iot_platform',
    baseUrl: null, // device/NVR host
    credentials: [
      { key: 'device_host', label: 'Camera / NVR Host / IP', required: true, public: false },
      { key: 'device_port', label: 'HTTP Port (default 80)', required: false, public: false },
      { key: 'username', label: 'Device Username', required: true, public: false },
      { key: 'password', label: 'Device Password', required: true, public: false },
    ],
    docs: 'https://www.hikvision.com/en/support/download/developer-tools/',
  },

  // Dahua HTTP API — cameras/NVRs, digest auth on port 80/443.
  dahua: {
    name: 'Dahua (HTTP API)',
    category: 'iot_platform',
    baseUrl: null, // device/NVR host
    credentials: [
      { key: 'device_host', label: 'Camera / NVR Host / IP', required: true, public: false },
      { key: 'device_port', label: 'HTTP Port (default 80)', required: false, public: false },
      { key: 'username', label: 'Device Username', required: true, public: false },
      { key: 'password', label: 'Device Password', required: true, public: false },
    ],
    docs: 'https://www.dahuatech.com',
  },

  // Generic IoT platform umbrella (MQTT/HTTP device cloud: ThingsBoard,
  // AWS IoT, Azure IoT Hub, or a property's own broker).
  iot_platform: {
    name: 'IoT Platform (generic MQTT/HTTP)',
    category: 'iot_platform',
    baseUrl: null, // platform-specific endpoint
    credentials: [
      { key: 'platform_url', label: 'Platform Endpoint URL', required: true, public: false },
      { key: 'api_key', label: 'API Key / Device Token', required: true, public: false },
      { key: 'protocol', label: 'Protocol (mqtt|http)', required: false, public: false },
    ],
    docs: null,
  },
};

module.exports = {
  SERVICE_DEFINITIONS,

  /**
   * Get all available services, optionally filtered by category
   */
  getAvailableServices(category = null) {
    if (!category) return Object.keys(SERVICE_DEFINITIONS);
    return Object.entries(SERVICE_DEFINITIONS)
      .filter(([, def]) => def.category === category)
      .map(([key]) => key);
  },

  /**
   * Get service definition
   */
  getServiceDefinition(serviceKey) {
    return SERVICE_DEFINITIONS[serviceKey] || null;
  },

  /**
   * Get all categories
   */
  getCategories() {
    return [...new Set(Object.values(SERVICE_DEFINITIONS).map(d => d.category))];
  },
};
