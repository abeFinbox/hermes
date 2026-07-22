//go:build !darwin && !linux

package server

func sysTotalMem() uint64 { return 0 }
