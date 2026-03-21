package session

import "testing"

func TestNormalizeOwnership(t *testing.T) {
	tests := []struct {
		in   string
		want Ownership
	}{
		{in: "", want: OwnershipUser},
		{in: "user", want: OwnershipUser},
		{in: "cato", want: OwnershipCato},
		{in: "managed", want: OwnershipCato},
		{in: "conductor", want: OwnershipCato},
	}

	for _, tt := range tests {
		if got := NormalizeOwnership(tt.in); got != tt.want {
			t.Fatalf("NormalizeOwnership(%q) = %q, want %q", tt.in, got, tt.want)
		}
	}
}

func TestInstanceToggleOwnership(t *testing.T) {
	inst := NewInstance("test", "/tmp")
	if inst.OwnershipMode() != OwnershipUser {
		t.Fatalf("default ownership = %q, want %q", inst.OwnershipMode(), OwnershipUser)
	}

	if next := inst.ToggleOwnership(); next != OwnershipCato {
		t.Fatalf("first toggle = %q, want %q", next, OwnershipCato)
	}
	if !inst.IsCatoManaged() {
		t.Fatal("expected IsCatoManaged true after first toggle")
	}

	if next := inst.ToggleOwnership(); next != OwnershipUser {
		t.Fatalf("second toggle = %q, want %q", next, OwnershipUser)
	}
	if inst.IsCatoManaged() {
		t.Fatal("expected IsCatoManaged false after second toggle")
	}
}
