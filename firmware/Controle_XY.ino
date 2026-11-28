// ============================================================
// XADREZ AUTOMATICO - CONTROLE XY POR COORDENADAS
// Arduino + drivers de motores de passo + eletroima
//
// PINOS:
//   X: DIR=5, PUL=6
//   Y: DIR=8, PUL=9
//   IMA=10
//
// COMANDOS SERIAIS (115200 baud):
//   GOTO,x,y   Move para coordenadas em milimetros
//   ZERO      Define a posicao atual como origem
//   STOP      Interrompe o movimento
//   IMA,1     Liga o eletroima
//   IMA,0     Desliga o eletroima
//
// SEGURANCA:
//   STOP e ZERO desligam o eletroima automaticamente.
//
// RESPOSTAS:
//   POS,x,y    Posicao estimada em passos
//   MOVENDO    Movimento iniciado
//   DONE       Movimento concluido
//   STOPPED    Movimento interrompido
//   ZERO_OK    Origem definida
//   ERRO,...   Erro de comando ou limite
// ============================================================

#include <math.h>
#include <string.h>
#include <stdlib.h>

// Protótipo usado pela parada de emergência para soltar a peça.
void definirIMA(bool ligar);

// ------------------------------------------------------------
// PINOS
// ------------------------------------------------------------

const int DIR_X = 5;
const int PUL_X = 6;

const int DIR_Y = 8;
const int PUL_Y = 9;

const int PINO_IMA = 10;

// ------------------------------------------------------------
// CONFIGURACAO DA MECANICA
// ------------------------------------------------------------

// Quantidade de passos por milimetro.
// Mantenha os valores usados na sua mecanica.

const float STEPS_PER_MM_X = 80.0;
const float STEPS_PER_MM_Y = 80.0;

// Limites fisicos dos eixos, em milimetros.
// AJUSTE para o tamanho real do seu tabuleiro.

const float MAX_X_MM = 400.0;
const float MAX_Y_MM = 400.0;

// Velocidade dos motores.
// Menor intervalo = maior velocidade.
// Se perder passos, aumente este valor.

const unsigned long STEP_INTERVAL = 100;

// Duracao do pulso PUL em microssegundos.
// Ajuste conforme o driver utilizado.

const unsigned long PULSE_WIDTH = 5;

// ------------------------------------------------------------
// ESTRUTURA DOS MOTORES
// ------------------------------------------------------------

struct Motor {
  int dirPin;
  int pulPin;

  long posicao;
  long destino;

  bool pulsoAlto;

  unsigned long inicioPulso;
  unsigned long proximoPasso;
};

Motor motorX = {
  DIR_X, PUL_X,
  0, 0,
  false,
  0, 0
};

Motor motorY = {
  DIR_Y, PUL_Y,
  0, 0,
  false,
  0, 0
};

// ------------------------------------------------------------
// COMUNICACAO SERIAL
// ------------------------------------------------------------

char buffer[64];
int bufferPos = 0;

bool imaLigado = false;
bool movimentoConcluido = true;

unsigned long ultimaAtualizacao = 0;

// ------------------------------------------------------------
// POSICAO
// ------------------------------------------------------------

bool motorParado(const Motor &m) {
  return m.posicao == m.destino && !m.pulsoAlto;
}

bool todosParados() {
  return motorParado(motorX) && motorParado(motorY);
}

void imprimirPosicao() {
  Serial.print("POS,");
  Serial.print(motorX.posicao);
  Serial.print(",");
  Serial.println(motorY.posicao);
}

void enviarPosicao() {
  if (millis() - ultimaAtualizacao >= 100) {
    ultimaAtualizacao = millis();
    imprimirPosicao();
  }
}

// ------------------------------------------------------------
// FINALIZAR PULSOS ATUAIS
// ------------------------------------------------------------

void aguardarPulsos() {
  while (motorX.pulsoAlto || motorY.pulsoAlto) {
    unsigned long agora = micros();

    if (motorX.pulsoAlto &&
        agora - motorX.inicioPulso >= PULSE_WIDTH) {

      digitalWrite(motorX.pulPin, LOW);
      motorX.pulsoAlto = false;

      if (digitalRead(motorX.dirPin) == HIGH) {
        motorX.posicao++;
      } else {
        motorX.posicao--;
      }
    }

    if (motorY.pulsoAlto &&
        agora - motorY.inicioPulso >= PULSE_WIDTH) {

      digitalWrite(motorY.pulPin, LOW);
      motorY.pulsoAlto = false;

      if (digitalRead(motorY.dirPin) == HIGH) {
        motorY.posicao++;
      } else {
        motorY.posicao--;
      }
    }
  }
}

// ------------------------------------------------------------
// CONTROLE DOS MOTORES
// ------------------------------------------------------------

void definirDestino(Motor &m, long destino) {
  m.destino = destino;

  if (m.posicao == m.destino) {
    return;
  }

  bool sentidoPositivo = m.destino > m.posicao;

  digitalWrite(
    m.dirPin,
    sentidoPositivo ? LOW : HIGH
  );

  m.proximoPasso = micros() + 5;
}

void pararMotores() {
  // Termina os pulsos que ja foram iniciados.
  aguardarPulsos();

  // Cancela os movimentos restantes.
  motorX.destino = motorX.posicao;
  motorY.destino = motorY.posicao;

  // Segurança: nunca deixar o eletroímã ligado após STOP ou ZERO.
  if (imaLigado) {
    definirIMA(false);
  }

  movimentoConcluido = true;
}

void atualizarMotor(Motor &m) {
  unsigned long agora = micros();

  // Finaliza o pulso atual.
  if (m.pulsoAlto) {
    if (agora - m.inicioPulso >= PULSE_WIDTH) {
      digitalWrite(m.pulPin, LOW);
      m.pulsoAlto = false;

      // Atualiza a posicao estimada.
      if (digitalRead(m.dirPin) == HIGH) {
        m.posicao++;
      } else {
        m.posicao--;
      }
    }

    return;
  }

  // O motor ja chegou ao destino.
  if (m.posicao == m.destino) {
    return;
  }

  // Aguarda o intervalo entre passos.
  if ((long)(agora - m.proximoPasso) < 0) {
    return;
  }

  // Define o sentido conforme a distancia restante.
  bool sentidoPositivo = m.destino > m.posicao;

  digitalWrite(
    m.dirPin,
    sentidoPositivo ? HIGH : LOW
  );

  // Executa um passo.
  digitalWrite(m.pulPin, HIGH);

  m.pulsoAlto = true;
  m.inicioPulso = agora;

  m.proximoPasso = agora + STEP_INTERVAL;
}

void atualizarMotores() {
  atualizarMotor(motorX);
  atualizarMotor(motorY);

  // Verifica se os dois eixos chegaram.
  if (!movimentoConcluido && todosParados()) {
    movimentoConcluido = true;
    Serial.println("DONE");
  }
}

// ------------------------------------------------------------
// MOVIMENTO ABSOLUTO
// ------------------------------------------------------------

void moverPara(float x, float y) {
  // Verifica os limites de movimentacao.
  if (x < 0 || x > MAX_X_MM ||
      y < 0 || y > MAX_Y_MM) {

    Serial.println("ERRO,LIMITE");
    return;
  }

  // Converte milimetros em passos.
  long destinoX = lround(x * STEPS_PER_MM_X);
  long destinoY = lround(y * STEPS_PER_MM_Y);

  // Define os destinos dos dois eixos.
  definirDestino(motorX, destinoX);
  definirDestino(motorY, destinoY);

  movimentoConcluido = false;

  Serial.println("MOVENDO");
}

// ------------------------------------------------------------
// ELETROIMA
// ------------------------------------------------------------

void definirIMA(bool ligar) {
  imaLigado = ligar;

  digitalWrite(
    PINO_IMA,
    ligar ? HIGH : LOW
  );

  Serial.print("IMA,");
  Serial.println(ligar ? 1 : 0);
}

// ------------------------------------------------------------
// ZERAR POSICAO
// ------------------------------------------------------------

void zerarPosicao() {
  // Para os motores antes de definir a origem.
  pararMotores();

  motorX.posicao = 0;
  motorY.posicao = 0;

  motorX.destino = 0;
  motorY.destino = 0;

  imprimirPosicao();

  Serial.println("ZERO_OK");
}

// ------------------------------------------------------------
// PROCESSAMENTO DE COMANDOS
// ------------------------------------------------------------

void processarComando() {
  buffer[bufferPos] = '\0';
  bufferPos = 0;

  if (buffer[0] == '\0') {
    return;
  }

  // Define a origem.
  if (strcmp(buffer, "ZERO") == 0) {
    zerarPosicao();
    return;
  }

  // Interrompe o movimento.
  if (strcmp(buffer, "STOP") == 0) {
    pararMotores();

    Serial.println("STOPPED");
    imprimirPosicao();

    return;
  }

  // Solicita a posicao atual.
  if (strcmp(buffer, "POS") == 0) {
    imprimirPosicao();
    return;
  }

  // Controle do eletroima.
  if (strncmp(buffer, "IMA,", 4) == 0) {
    int estado = atoi(buffer + 4);

    definirIMA(estado != 0);
    return;
  }

  // Movimento para coordenadas.
  if (strncmp(buffer, "GOTO,", 5) == 0) {
    char *separador = strchr(buffer + 5, ',');

    if (separador == NULL) {
      Serial.println("ERRO,COMANDO");
      return;
    }

    *separador = '\0';

    float x = atof(buffer + 5);
    float y = atof(separador + 1);

    moverPara(x, y);
    return;
  }

  Serial.println("ERRO,COMANDO");
}

// ------------------------------------------------------------
// RECEBER COMANDOS
// ------------------------------------------------------------

void receberComando() {
  while (Serial.available()) {
    char c = Serial.read();

    if (c == '\n') {
      processarComando();
    }
    else if (c != '\r') {
      if (bufferPos < sizeof(buffer) - 1) {
        buffer[bufferPos++] = c;
      } else {
        // Descarta comandos maiores que o buffer.
        bufferPos = 0;
      }
    }
  }
}

// ------------------------------------------------------------
// SETUP
// ------------------------------------------------------------

void setup() {
  pinMode(DIR_X, OUTPUT);
  pinMode(PUL_X, OUTPUT);

  pinMode(DIR_Y, OUTPUT);
  pinMode(PUL_Y, OUTPUT);

  pinMode(PINO_IMA, OUTPUT);

  digitalWrite(PUL_X, LOW);
  digitalWrite(PUL_Y, LOW);
  digitalWrite(PINO_IMA, LOW);

  Serial.begin(115200);

  Serial.println("PRONTO");

  definirIMA(false);
}

// ------------------------------------------------------------
// LOOP
// ------------------------------------------------------------

void loop() {
  receberComando();

  atualizarMotores();

  enviarPosicao();
}