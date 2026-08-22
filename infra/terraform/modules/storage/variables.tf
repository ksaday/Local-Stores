variable "bucket_name" {
  description = "Globally unique, as all S3 bucket names are."
  type        = string
}

variable "domain_name" {
  description = "The app's origin, for the CORS rule. Presigned uploads PUT straight from the browser, which is cross-origin."
  type        = string
}

variable "tags" {
  type    = map(string)
  default = {}
}
