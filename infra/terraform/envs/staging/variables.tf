variable "region" {
  type    = string
  default = "us-east-2"
}

variable "hosted_zone_name" {
  description = "Route 53 zone, which must already exist — delegation happens at the registrar."
  type        = string
}

variable "domain_name" {
  type = string
}

variable "cdn_domain_name" {
  description = "Media origin. Separate from the app so an uploaded file cannot reach app cookies."
  type        = string
}

variable "media_bucket_name" {
  description = "Globally unique."
  type        = string
}

variable "stripe_ip_ranges" {
  description = "Stripe's published webhook ranges. Empty means no IP restriction — signature verification is the real control."
  type        = list(string)
  default     = []
}

variable "image_tag" {
  description = "Git SHA of the images to run. Never `latest` — a mutable tag makes a rollback ambiguous."
  type        = string
}

variable "pgbouncer_image_tag" {
  description = "Built from infra/docker/pgbouncer. Changes far less often than the app images."
  type        = string
  default     = "latest"
}

variable "otlp_endpoint" {
  description = "OTLP collector. Empty disables tracing entirely."
  type        = string
  default     = ""
}
