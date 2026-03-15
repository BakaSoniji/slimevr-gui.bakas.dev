variable "domain_name" {
  description = "Domain name for the SlimeVR GUI site (e.g., slimevr-gui.bakas.dev)"
  type        = string
}

variable "route53_zone_name" {
  description = "Route53 hosted zone name (e.g., bakas.dev)"
  type        = string
}

variable "s3_bucket_name" {
  description = "S3 bucket name for site content"
  type        = string
}
