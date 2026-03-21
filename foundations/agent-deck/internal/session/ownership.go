package session

import "strings"

// Ownership identifies who controls execution for a lane.
type Ownership string

const (
	// OwnershipUser means lane is user-managed; Cato observes but does not act.
	OwnershipUser Ownership = "user"
	// OwnershipCato means lane is Cato-managed; heartbeat is expected to keep it moving.
	OwnershipCato Ownership = "cato"
)

// NormalizeOwnership converts raw persisted values to the supported ownership set.
func NormalizeOwnership(raw string) Ownership {
	switch strings.ToLower(strings.TrimSpace(raw)) {
	case "cato", "managed", "conductor":
		return OwnershipCato
	default:
		return OwnershipUser
	}
}

func (o Ownership) String() string {
	return string(NormalizeOwnership(string(o)))
}

// OwnershipLabel returns a stable lowercase label for CLI/JSON/UI views.
func OwnershipLabel(raw string) string {
	return NormalizeOwnership(raw).String()
}

// IsCatoManagedOwnership reports whether raw ownership resolves to Cato-managed.
func IsCatoManagedOwnership(raw string) bool {
	return NormalizeOwnership(raw) == OwnershipCato
}

// OwnershipMode returns normalized ownership for this instance.
func (inst *Instance) OwnershipMode() Ownership {
	if inst == nil {
		return OwnershipUser
	}
	return NormalizeOwnership(inst.Ownership)
}

// SetOwnership updates ownership with normalization.
func (inst *Instance) SetOwnership(owner Ownership) {
	if inst == nil {
		return
	}
	inst.Ownership = owner.String()
}

// ToggleOwnership flips between user and Cato ownership.
func (inst *Instance) ToggleOwnership() Ownership {
	if inst == nil {
		return OwnershipUser
	}
	if inst.OwnershipMode() == OwnershipCato {
		inst.Ownership = OwnershipUser.String()
		return OwnershipUser
	}
	inst.Ownership = OwnershipCato.String()
	return OwnershipCato
}

// IsCatoManaged reports whether this instance is owned by Cato.
func (inst *Instance) IsCatoManaged() bool {
	if inst == nil {
		return false
	}
	return inst.OwnershipMode() == OwnershipCato
}
