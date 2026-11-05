variable "provisioning_approved" {
  type        = bool
  default     = false
  description = "Financial/resource gate. Keep false until the exact plan is approved. Mock tests use true without a real provider."
}
variable "project_id" {
  type    = string
  default = null
  validation {
    condition     = var.project_id == null ? !var.provisioning_approved : can(regex("^[a-f0-9-]{36}$", var.project_id))
    error_message = "An explicitly authorized project UUID is required."
  }
}
variable "zone" {
  type    = string
  default = "fr-par-2"
  validation {
    condition     = var.zone == "fr-par-2"
    error_message = "Only the reviewed fr-par-2 placement is prepared."
  }
}
variable "generation" {
  type    = string
  default = "gromesh-j8-20261105a"
  validation {
    condition     = can(regex("^gromesh-j8-[a-z0-9]{8,24}$", var.generation))
    error_message = "Use a unique owned generation; N2 and other projects are excluded."
  }
}
variable "operator_cidr" {
  type    = string
  default = null
  validation {
    condition     = var.operator_cidr == null ? !var.provisioning_approved : can(cidrhost(var.operator_cidr, 0)) && can(regex("/32$", var.operator_cidr)) && !can(regex("^(0\\.|10\\.|127\\.|169\\.254\\.|192\\.168\\.|172\\.(1[6-9]|2[0-9]|3[01])\\.)", var.operator_cidr))
    error_message = "An explicit public operator IPv4/32 is required, never an open or N2 route."
  }
}
variable "admin_ssh_public_key" {
  type    = string
  default = null
  validation {
    condition     = var.admin_ssh_public_key == null ? !var.provisioning_approved : can(regex("^ssh-ed25519 [A-Za-z0-9+/=]+( [A-Za-z0-9._@-]+)?$", var.admin_ssh_public_key))
    error_message = "Use a new dedicated Ed25519 public key; never a private key or a shared Mac administrator key."
  }
}
variable "image_ids" {
  type    = map(string)
  default = {}
  validation {
    condition     = length(var.image_ids) == 0 ? !var.provisioning_approved : toset(keys(var.image_ids)) == toset(["amd64", "arm64"]) && alltrue([for id in values(var.image_ids) : can(regex("^[a-f0-9-]{36}$", id))])
    error_message = "Pin the reviewed Ubuntu24.04 local image UUID for each native architecture, not a moving label."
  }
}
variable "worker_state" {
  type    = string
  default = "started"
  validation {
    condition     = contains(["started", "stopped"], var.worker_state)
    error_message = "Use provider started/stopped; standby is billed and is not an economic shutdown."
  }
}
variable "public_enrollment" {
  type        = map(string)
  default     = {}
  description = "Only public peer JSON supplied after host fingerprints are authenticated. No private keys or tokens."
  validation {
    condition     = alltrue([for body in values(var.public_enrollment) : can(jsondecode(body)) && !can(regex("(?i)(private.?key|password|token|secret)", body))])
    error_message = "Enrollment carries only public, role-bound WireGuard peers."
  }
}
variable "create_artifact_bucket" {
  type    = bool
  default = false
}
variable "artifact_budget_gib" {
  type    = number
  default = 100
  validation {
    condition     = contains([100, 250, 500], var.artifact_budget_gib)
    error_message = "Pilot budget100GiB; expansion250/500GiB only after measurement/approval. This is not a backend hard quota."
  }
}

variable "server_protection_enabled" {
  type        = bool
  default     = true
  description = "Disable only after approving exact IDs for an economic poweroff; keep Terraform prevent_destroy. Restore true after stopped."
}
