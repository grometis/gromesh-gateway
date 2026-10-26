package agent

import (
	"context"
	"net"
	"net/http"
	"net/http/httptest"
	"testing"
)

// Kong shares the pod's network namespace (B §3.5, CAP-6): the agent's metrics refuse the pod itself.
func TestMetricsRefuseTheirOwnPod(t *testing.T) {
	a := &Agent{}
	local := &net.TCPAddr{IP: net.ParseIP("10.244.1.7"), Port: 9100}
	for remote, want := range map[string]int{
		"10.244.2.9:40000":     http.StatusOK,        // the scraper on another pod
		"10.244.1.7:40000":     http.StatusForbidden, // the pod's own address
		"127.0.0.1:40000":      http.StatusForbidden,
		"127.0.0.2:40000":      http.StatusForbidden,
		"[::1]:40000":          http.StatusForbidden,
		"[::ffff:127.0.0.1]:1": http.StatusForbidden,
		"garbage":              http.StatusForbidden,
	} {
		req := httptest.NewRequest("GET", "/metrics", nil).WithContext(context.WithValue(context.Background(), http.LocalAddrContextKey, local))
		req.RemoteAddr = remote
		w := httptest.NewRecorder()
		a.MetricsHandler().ServeHTTP(w, req)
		if w.Code != want {
			t.Errorf("%s: %d, want %d", remote, w.Code, want)
		}
	}
}

func TestMetricsOverLoopbackAreRefusedOnARealListener(t *testing.T) {
	server := httptest.NewServer((&Agent{}).MetricsHandler())
	defer server.Close()
	res, err := http.Get(server.URL + "/metrics")
	if err != nil {
		t.Fatal(err)
	}
	res.Body.Close()
	if res.StatusCode != http.StatusForbidden {
		t.Fatalf("loopback scrape: %d", res.StatusCode)
	}
}

// A client in the pod binds its source to a non-loopback address of the pod and connects through loopback.
func TestMetricsRefuseThePodsOwnAddressThroughLoopback(t *testing.T) {
	var own net.IP
	addrs, _ := net.InterfaceAddrs()
	for _, a := range addrs {
		if n, ok := a.(*net.IPNet); ok && n.IP.To4() != nil && !n.IP.IsLoopback() && !n.IP.IsLinkLocalUnicast() {
			own = n.IP
			break
		}
	}
	if own == nil {
		t.Skip("no non-loopback IPv4 interface")
	}
	server := httptest.NewServer((&Agent{}).MetricsHandler())
	defer server.Close()
	client := &http.Client{Transport: &http.Transport{DialContext: (&net.Dialer{LocalAddr: &net.TCPAddr{IP: own}}).DialContext}}
	res, err := client.Get(server.URL + "/metrics")
	if err != nil {
		t.Fatal(err)
	}
	res.Body.Close()
	if res.StatusCode != http.StatusForbidden {
		t.Fatalf("source %s through loopback: %d", own, res.StatusCode)
	}
}
