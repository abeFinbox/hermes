//go:build darwin

package server

import "golang.org/x/sys/unix"

// sysTotalMem reads hw.memsize (total physical RAM in bytes) on macOS.
func sysTotalMem() uint64 {
	if v, err := unix.SysctlUint64("hw.memsize"); err == nil {
		return v
	}
	return 0
}
