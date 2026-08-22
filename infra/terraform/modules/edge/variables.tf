variable "name" {
  type = string
}

variable "hosted_zone_id" {
  description = "From modules/dns, which owns the zone lookup and both certificates."
  type        = string
}

variable "certificate_arn" {
  description = "The us-east-1 certificate. CloudFront accepts no other region."
  type        = string
}

variable "domain_name" {
  description = "The app. §14.8 keeps storefronts on the same origin at /stores/{slug} so SEO authority stays consolidated."
  type        = string
}

variable "cdn_domain_name" {
  description = "Media, on a separate origin so a CSP bypass in an uploaded file cannot reach app cookies."
  type        = string
}

variable "media_bucket_name" {
  description = "From modules/storage. The bucket policy attaches here because it names this distribution."
  type        = string
}

variable "media_bucket_arn" {
  type = string
}

variable "media_bucket_regional_domain_name" {
  type = string
}

variable "alb_dns_name" {
  description = "CloudFront's origin. Never given out directly — the ALB refuses anything without the secret header."
  type        = string
}

variable "origin_secret" {
  description = "Proves a request came from this distribution. See the compute module's listener."
  type        = string
  sensitive   = true
}

variable "origin_secret_header_name" {
  type    = string
  default = "x-bba-origin"
}

variable "rate_limit_per_5min" {
  description = "Per source IP. Generous on purpose: an office NAT and a block of flats share an address."
  type        = number
  default     = 20000
}

variable "stripe_ip_ranges" {
  description = <<-EOT
    Stripe's published webhook ranges (§14.1). Empty means no IP restriction,
    which is the safe default — an empty allowlist that blocked every webhook
    would take payments down looking like a Stripe outage. Signature
    verification is the real control; this is defence in depth.
  EOT
  type        = list(string)
  default     = []
}

variable "price_class" {
  description = "PriceClass_100 is North America and Europe. Widen when there are customers to widen it for."
  type        = string
  default     = "PriceClass_100"
}

variable "tags" {
  type    = map(string)
  default = {}
}
