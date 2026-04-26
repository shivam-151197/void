%matplotlib inline

from matplotlib import pyplot as plt
import numpy as np

# Random Weights
np.random.seed(0)
b = 2 * np.random.rand() - 1
w1 = 2*  np.random.randn() - 1
w2 = np.random.randn() - 1
#print(b)
#print(w1)
#print(w2)

# Activation Function
def ReLU(x):
    return x * (x > 0)

def dReLU(x):
    return 1. * (x > 0)

#functional plot b/w Activation Function and its Derivative

plt.axis([-4, 4, 0, 1])
plt.grid()
X = np.linspace(-5, 5, 100)
Y = ReLU(X)
J = dReLU(X)
plt.plot(X,Y, c='b')
plt.plot(X,J, c='r')

# Point Scattering 
#point scattering
plt.axis([-1, 2, -1, 2])
plt.grid()
for i in range(len(data)):
    point = data[i]
    #print (point)
    color = 'r'
    print (point[2])
    if point[2] == 0:
        color = 'b'
    plt.scatter(point[0],point[1], c = color)

# Training Function

learning_rate = 0.1
costs = []

for i in range(1, 10000):
    ri = len(data) % 4
    point = data[ri]
    
    z = point[0] * w1 + point[1] * w2 + b
    h = ReLU(z)
    #print(h)
    target = point[2]
    cost = np.square(h - target)
    costs.append(cost)
    print (cost)
    
    # Variable Derevetive
    
    der_h = 2 * (h - target)
    der_h_dz = dReLU(z)
    
    dz_w1 = point[0]
    dz_w2 = point[1]
    dz_b = 1
    
    # Model Derivative
    
    dcost_dz = der_h * der_h_dz
    
    dcost_w1 = dcost_dz * dz_w1
    dcost_w2 = dcost_dz * dz_w2
    dcost_db = dcost_dz * dz_b
    
    # Tweeking parameters
    
    #w1 = w1 - learning_rate * dcost_dw1
    b = b - learning_rate * dcost_db
    plt.plot(costs)

#New Weights and Bias

b = -0.036097203531139
w1 = 0.4831834816183227
w2 = 0.5529137219128164

#Test

z = 0 * w1 + 0 * w2 + b
print(z)
K = ReLU(z)
print (K)

#Output
-0.0
