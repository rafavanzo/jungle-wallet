#!/bin/sh
set -eu

ENDPOINT="${SQS_ENDPOINT:-http://sqs:4566}"
MAX_RECEIVE_COUNT="${MAX_RECEIVE_COUNT:-5}"

aws_sqs() { aws --endpoint-url "$ENDPOINT" sqs "$@"; }

echo "Aguardando SQS em $ENDPOINT..."
tries=0
until aws_sqs list-queues >/dev/null 2>&1; do
  tries=$((tries + 1))
  if [ "$tries" -ge 60 ]; then
    echo "SQS não respondeu após 60s" >&2
    exit 1
  fi
  sleep 1
done

# 1) DLQ primeiro: a fila principal precisa do ARN dela
DLQ_URL=$(aws_sqs create-queue \
  --queue-name wager-transactions-dlq.fifo \
  --attributes FifoQueue=true,MessageRetentionPeriod=1209600 \
  --query QueueUrl --output text)

DLQ_ARN=$(aws_sqs get-queue-attributes \
  --queue-url "$DLQ_URL" \
  --attribute-names QueueArn \
  --query Attributes.QueueArn --output text)

# 2) Atributos da fila principal (RedrivePolicy é um JSON dentro de JSON)
printf '{"FifoQueue":"true","ContentBasedDeduplication":"false","VisibilityTimeout":"30","RedrivePolicy":"{\\"deadLetterTargetArn\\":\\"%s\\",\\"maxReceiveCount\\":\\"%s\\"}"}' \
  "$DLQ_ARN" "$MAX_RECEIVE_COUNT" > /tmp/attrs.json

aws_sqs create-queue \
  --queue-name wager-transactions.fifo \
  --attributes file:///tmp/attrs.json

echo "Filas criadas:"
aws_sqs list-queues
