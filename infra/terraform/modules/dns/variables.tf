variable "name" {
  type = string
}

variable "hosted_zone_name" {
  description = "Must already exist. Delegation happens at the registrar, which is outside Terraform."
  type        = string
}

variable "domain_name" {
  type = string
}

variable "cdn_domain_name" {
  type = string
}

variable "tags" {
  type    = map(string)
  default = {}
}
