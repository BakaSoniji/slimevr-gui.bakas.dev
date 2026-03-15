output "cloudfront_distribution_id" {
  description = "CloudFront distribution ID (set as CLOUDFRONT_DISTRIBUTION_ID in GitHub Actions)"
  value       = aws_cloudfront_distribution.site.id
}

output "s3_bucket_name" {
  description = "S3 bucket name"
  value       = aws_s3_bucket.site.id
}
