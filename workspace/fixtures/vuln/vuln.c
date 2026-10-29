/*
 * Deliberately vulnerable fixture for arachne's self-test.
 * A "log shipper" with three real defects on the argv path.
 * Build: clang -g -O1 -fsanitize=address,undefined vuln.c -o vuln
 */
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#define MAX_RECORD 64

static int record_count = 0;

/* CWE-121: fixed stack buffer, unbounded copy from argv. */
static void store_record(const char *record) {
    char buffer[MAX_RECORD];
    strcpy(buffer, record);
    record_count++;
    printf("stored %d: %s\n", record_count, buffer);
}

/* CWE-787: length read from the same record, no clamp against dst size. */
static void append_fields(char *dst, const char *src, size_t len) {
    memcpy(dst, src, len);
}

/* CWE-78: shell invocation built from the record. */
static void run_filter(const char *record) {
    char cmd[128];
    sprintf(cmd, "grep -c '%s' /dev/null", record);
    system(cmd);
}

static void usage(const char *argv0) {
    fprintf(stderr, "usage: %s <record>\n", argv0);
    exit(2);
}

int main(int argc, char **argv) {
    if (argc < 2) usage(argv[0]);

    const char *record = argv[1];
    store_record(record);

    char scratch[32] = {0};
    append_fields(scratch, record, strlen(record));

    if (getenv("VULN_FILTER")) run_filter(record);
    return 0;
}
