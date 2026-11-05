terraform {
  required_version = "= 1.13.3"
  required_providers {
    scaleway = {
      source  = "scaleway/scaleway"
      version = "= 2.91.0"
    }
  }
}
provider "scaleway" {
  region     = "fr-par"
  zone       = var.zone
  project_id = var.project_id
  # Credentials supplied only through dedicated SCW_* environment after explicit authorization.
}
