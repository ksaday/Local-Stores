variable "region" {
  type    = string
  default = "us-east-2"
}

variable "certificate_arn" {
  description = "ACM certificate for the ALB listener, in this region. Created outside this configuration because DNS validation is interactive."
  type        = string
}

variable "image_tag" {
  description = "Git SHA of the images to run. Never `latest` — a mutable tag makes a rollback ambiguous."
  type        = string
}

variable "otlp_endpoint" {
  description = "OTLP collector. Empty disables tracing entirely."
  type        = string
  default     = ""
}
