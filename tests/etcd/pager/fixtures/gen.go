//go:build ignore

// Generates the bbolt fixtures used by oracle.test.js. Not run by the tests.
//
//	d=$(mktemp -d) && sed 1d gen.go > "$d/main.go" && cd "$d" && go mod init gen &&
//	  go get go.etcd.io/bbolt@v1.5.0 && go run . /path/to/tests/etcd/pager/fixtures
package main

import (
	"fmt"
	"os"
	"path/filepath"

	bolt "go.etcd.io/bbolt"
)

func main() {
	dir := os.Args[1]
	for _, ps := range []int{4096, 16384} {
		name := filepath.Join(dir, fmt.Sprintf("bbolt-keys-%d.db", ps))
		os.Remove(name)
		db, err := bolt.Open(name, 0600, &bolt.Options{PageSize: ps})
		if err != nil {
			panic(err)
		}
		// Three commits: create a bucket with keys, then overwrite some, so the freelist is not empty.
		for round := 0; round < 3; round++ {
			err = db.Update(func(tx *bolt.Tx) error {
				b, err := tx.CreateBucketIfNotExists([]byte("registry"))
				if err != nil {
					return err
				}
				for i := 0; i < 200; i++ {
					k := fmt.Sprintf("/registry/pods/default/pod-%03d", i)
					v := fmt.Sprintf("round-%d-%0300d", round, i)
					if err := b.Put([]byte(k), []byte(v)); err != nil {
						return err
					}
				}
				return nil
			})
			if err != nil {
				panic(err)
			}
		}
		db.Close()
	}
}
