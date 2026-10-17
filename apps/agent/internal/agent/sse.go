package agent

import (
	"bufio"
	"context"
	"encoding/json"
	"fmt"
	"math/rand/v2"
	"mime"
	"net/http"
	"strings"
	"time"
)

func retryDelay(attempt int) time.Duration {
	if attempt > 5 {
		attempt = 5
	}
	ceiling := min(time.Second*time.Duration(1<<attempt), 30*time.Second)
	return time.Duration(float64(ceiling) * (0.5 + 0.5*rand.Float64()))
}

func wait(ctx context.Context, delay time.Duration) bool {
	timer := time.NewTimer(delay)
	defer timer.Stop()
	select {
	case <-ctx.Done():
		return false
	case <-timer.C:
		return true
	}
}

func (a *Agent) events(ctx context.Context, wake chan<- struct{}) {
	lastID := ""
	for attempt := 0; ctx.Err() == nil; attempt++ {
		active, err := a.stream(ctx, &lastID, wake)
		if ctx.Err() != nil {
			return
		}
		if err != nil {
			a.log.Warn("event stream disconnected")
		}
		if active {
			attempt = 0
		}
		if !wait(ctx, a.retry(attempt)) {
			return
		}
	}
}

func (a *Agent) stream(ctx context.Context, lastID *string, wake chan<- struct{}) (bool, error) {
	ctx, cancel := context.WithCancel(ctx)
	defer cancel()
	headers := map[string]string{"Accept": "text/event-stream"}
	if *lastID != "" {
		headers["Last-Event-ID"] = *lastID
	}
	// Unlike ordinary requests, a healthy SSE connection has no total timeout.
	res, err := a.client.nodeRequest(ctx, "GET", "/agent/v1/events", nil, headers)
	if err != nil {
		return false, err
	}
	defer res.Body.Close()
	contentType, _, _ := mime.ParseMediaType(res.Header.Get("Content-Type"))
	if res.StatusCode != http.StatusOK || contentType != "text/event-stream" {
		return false, fmt.Errorf("invalid event stream response")
	}
	timer := time.AfterFunc(a.streamIdle, cancel)
	defer timer.Stop()
	scanner := bufio.NewScanner(res.Body)
	scanner.Buffer(make([]byte, 4096), 1<<20)
	event, data, id := "", []string{}, *lastID
	active := false
	for scanner.Scan() {
		line := scanner.Text()
		if line == "" {
			if event == "ping" || strings.HasPrefix(event, "snapshot.") {
				active = true
				timer.Reset(a.streamIdle)
			}
			*lastID = id
			if event == "snapshot.published" {
				var published struct {
					Version int64  `json:"version"`
					Hash    string `json:"hash"`
				}
				if json.Unmarshal([]byte(strings.Join(data, "\n")), &published) == nil && published.Version >= 1 && hashPattern.MatchString(published.Hash) {
					select {
					case wake <- struct{}{}:
					default:
					}
				}
			}
			event, data = "", data[:0]
			continue
		}
		if strings.HasPrefix(line, ":") {
			continue
		}
		field, value, _ := strings.Cut(line, ":")
		value = strings.TrimPrefix(value, " ")
		switch field {
		case "event":
			event = value
		case "data":
			data = append(data, value)
		case "id":
			if !strings.ContainsRune(value, '\x00') {
				id = value
			}
		}
	}
	if err := scanner.Err(); err != nil {
		return active, err
	}
	return active, fmt.Errorf("event stream closed")
}
