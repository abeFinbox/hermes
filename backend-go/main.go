// Command backend-go is the Go implementation of the Hermes backend. It serves
// the same REST contract as the Node/Express backend (backend/src) and shares
// the same data/app.db and data/jwt-secret, so the frontend can toggle between
// the two at runtime with no loss of session or data. Listens on :4001 by default.
package main

import (
	"fmt"
	"log"
	"net/http"
	"os"

	"github.com/finbox/hermes/backend-go/internal/server"
	"github.com/finbox/hermes/backend-go/internal/store"
)

func main() {
	if err := store.Init(); err != nil {
		log.Fatalf("[hermes-go] store init failed: %v", err)
	}
	if err := store.SeedAdmin(); err != nil {
		log.Fatalf("[hermes-go] seed admin failed: %v", err)
	}
	server.StartMetrics()

	port := os.Getenv("PORT")
	if port == "" {
		port = "4001"
	}
	handler := server.New()
	fmt.Printf("[hermes-go] backend listening on http://localhost:%s\n", port)
	if err := http.ListenAndServe(":"+port, handler); err != nil {
		log.Fatalf("[hermes-go] server error: %v", err)
	}
}
